import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { CodeBuildClient, BatchGetProjectsCommand } from '@aws-sdk/client-codebuild';
import { CodePipelineClient, GetPipelineCommand } from '@aws-sdk/client-codepipeline';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';
import type {
  AwsProfile,
  PipelineAuditEntry,
  PipelineAuditResult,
} from '../../shared/types';
import {
  analyzeStack,
  compareWithDeployed,
  extractDeployedSnykCommands,
  findPipelineStacks,
  readCdkEnvs,
  resolvePipelineName,
  type DeployedPipelineShape,
  type StackAnalysis,
} from './pipeline-analysis';

export interface AuditableRepo {
  id: string;
  name: string;
  localPath: string;
}

const CONCURRENCY = 3;
// CodeBuild/CodePipeline throttle aggressively when many pipelines are audited
// at once, so retry with the SDK's backoff rather than failing the row.
const AWS_MAX_ATTEMPTS = 10;

function awsConfigPath(): string {
  return process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
}

function awsCredentialsPath(): string {
  return process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
}

/** Minimal INI parser: section name -> key/value map. */
export function parseIni(text: string): Map<string, Record<string, string>> {
  const sections = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = {};
      sections.set(header[1].trim(), current);
      continue;
    }
    const eq = line.indexOf('=');
    if (current && eq > 0) {
      current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

async function readIni(file: string): Promise<Map<string, Record<string, string>>> {
  try {
    return parseIni(await readFile(file, 'utf-8'));
  } catch {
    return new Map();
  }
}

/** Lists profiles from ~/.aws/config and ~/.aws/credentials (names only; no secrets). */
export async function listAwsProfiles(): Promise<AwsProfile[]> {
  const profiles = new Map<string, AwsProfile>();
  const config = await readIni(awsConfigPath());
  for (const [section, values] of config) {
    let name: string | null = null;
    if (section === 'default') name = 'default';
    else if (section.startsWith('profile ')) name = section.slice('profile '.length).trim();
    if (!name) continue; // sso-session / services sections
    profiles.set(name, {
      name,
      region: values.region,
      isSso: Boolean(values.sso_session || values.sso_start_url),
    });
  }
  const credentials = await readIni(awsCredentialsPath());
  for (const [name, values] of credentials) {
    if (!profiles.has(name)) profiles.set(name, { name, region: values.region, isSso: false });
  }
  return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

interface PendingEntry {
  entry: PipelineAuditEntry;
  analysis: StackAnalysis;
  stackFile: string;
  repoDir: string;
}

function describeAwsError(err: unknown, profile: string): string {
  const e = err as { name?: string; message?: string };
  const msg = e?.message || String(err);
  if (/sso|token|expired|credential/i.test(`${e?.name ?? ''} ${msg}`)) {
    return `${msg} (try: aws sso login --profile ${profile})`;
  }
  return msg;
}

async function fetchDeployedShape(
  pipelineClient: CodePipelineClient,
  buildClient: CodeBuildClient,
  pipelineName: string
): Promise<DeployedPipelineShape> {
  const { pipeline } = await pipelineClient.send(new GetPipelineCommand({ name: pipelineName }));
  const stageNames: string[] = [];
  const actionNames: string[] = [];
  const projectNames = new Set<string>();
  let sourceBranch: string | undefined;

  for (const stage of pipeline?.stages ?? []) {
    if (stage.name) stageNames.push(stage.name);
    for (const action of stage.actions ?? []) {
      if (action.name) actionNames.push(action.name);
      if (action.actionTypeId?.category === 'Source') {
        sourceBranch = action.configuration?.BranchName ?? action.configuration?.Branch ?? sourceBranch;
      }
      const project = action.configuration?.ProjectName;
      if (action.actionTypeId?.provider === 'CodeBuild' && project) projectNames.add(project);
    }
  }

  const snykCommands: string[] = [];
  let hasSnykProject = false;
  if (projectNames.size > 0) {
    const { projects } = await buildClient.send(
      new BatchGetProjectsCommand({ names: [...projectNames] })
    );
    for (const project of projects ?? []) {
      const cmds = extractDeployedSnykCommands(project.source?.buildspec);
      if (cmds.length > 0 || /snyk/i.test(project.source?.buildspec ?? '')) hasSnykProject = true;
      snykCommands.push(...cmds);
    }
  }
  return { stageNames, actionNames, sourceBranch, snykCommands, hasSnykProject };
}

/**
 * Audits the CDK pipeline stack of each repo for Snyk scanning completeness,
 * and (optionally, with an AWS profile) whether the deployed CodePipeline
 * matches the one defined in code.
 */
export async function auditPipelines(
  repos: AuditableRepo[],
  profile?: string
): Promise<PipelineAuditResult> {
  const result: PipelineAuditResult = {
    auditedAt: new Date().toISOString(),
    profile,
    entries: [],
  };
  const pending: PendingEntry[] = [];

  // 1. Static analysis of the source (always).
  await runPool(repos, async (repo) => {
    const stacks = await findPipelineStacks(repo.localPath);
    if (stacks.length === 0) {
      result.entries.push({
        repoId: repo.id,
        repoName: repo.name,
        snykStatus: 'nopipe',
        snykIssues: [],
        scaGating: 'n/a',
        hasGitSecrets: false,
        deployStatus: 'not-checked',
        deployedIssues: [],
      });
      return;
    }
    for (const stackFile of stacks) {
      let text: string;
      try {
        text = await readFile(stackFile, 'utf-8');
      } catch {
        continue;
      }
      const analysis = analyzeStack(text);
      const entry: PipelineAuditEntry = {
        repoId: repo.id,
        repoName: repo.name,
        stackFile: path.relative(repo.localPath, stackFile),
        pipelineName: resolvePipelineName(analysis.pipelineNameExpr),
        snykStatus: analysis.snyk.status,
        snykIssues: analysis.snyk.issues,
        scaGating: analysis.snyk.scaGating,
        snykOrg: analysis.snyk.org,
        hasGitSecrets: analysis.hasGitSecrets,
        deployStatus: 'not-checked',
        deployedIssues: [],
      };
      result.entries.push(entry);
      pending.push({ entry, analysis, stackFile, repoDir: repo.localPath });
    }
  });

  if (!profile || pending.length === 0) return result;

  // 2. Deployed-state comparison using the selected AWS profile.
  let credentials: ReturnType<typeof fromIni>;
  let accountId: string;
  try {
    credentials = fromIni({ profile });
    const profiles = await listAwsProfiles();
    const region = profiles.find((p) => p.name === profile)?.region ?? 'us-east-1';
    const sts = new STSClient({ region, credentials });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    accountId = identity.Account ?? '';
    result.accountId = accountId;
  } catch (err) {
    result.credentialsError = describeAwsError(err, profile);
    for (const p of pending) {
      p.entry.deployStatus = 'error';
      p.entry.deployedError = result.credentialsError;
    }
    return result;
  }

  const clients = new Map<string, { pipeline: CodePipelineClient; build: CodeBuildClient }>();
  const clientsFor = (region: string) => {
    let c = clients.get(region);
    if (!c) {
      c = {
        pipeline: new CodePipelineClient({ region, credentials, maxAttempts: AWS_MAX_ATTEMPTS }),
        build: new CodeBuildClient({ region, credentials, maxAttempts: AWS_MAX_ATTEMPTS }),
      };
      clients.set(region, c);
    }
    return c;
  };

  await runPool(pending, async ({ entry, analysis, stackFile, repoDir }) => {
    try {
      const envs = await readCdkEnvs(stackFile, repoDir);
      const env = envs.find((e) => e.account === accountId);
      if (!env) {
        entry.deployStatus = 'no-env';
        entry.deployedIssues = [`cdk.json has no environment for account ${accountId}`];
        return;
      }
      entry.envKey = env.envKey;
      entry.region = env.region;
      const name = resolvePipelineName(analysis.pipelineNameExpr, env.envKey);
      entry.pipelineName = name;
      if (!name) {
        entry.deployStatus = 'unknown';
        entry.deployedIssues = ['Pipeline name could not be resolved from source'];
        return;
      }
      const { pipeline, build } = clientsFor(env.region);
      let deployed: DeployedPipelineShape;
      try {
        deployed = await fetchDeployedShape(pipeline, build, name);
      } catch (err) {
        if ((err as { name?: string }).name === 'PipelineNotFoundException') {
          entry.deployStatus = 'not-deployed';
          entry.deployedIssues = [`Pipeline "${name}" not found in ${env.region}`];
          return;
        }
        throw err;
      }
      const diffs = compareWithDeployed(analysis, deployed, env.branch);
      entry.deployedIssues = diffs;
      entry.deployStatus = diffs.length > 0 ? 'out-of-sync' : 'in-sync';
    } catch (err) {
      entry.deployStatus = 'error';
      entry.deployedError = describeAwsError(err, profile);
    }
  });

  return result;
}
