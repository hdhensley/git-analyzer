import { readdir, readFile } from 'fs/promises';
import path from 'path';
import type { PipelineSnykStatus } from '../../shared/types';

/**
 * Pure helpers for statically analysing a CDK `*-pipeline-stack.ts` file and
 * for comparing it with a deployed CodePipeline. Nothing in here touches AWS or
 * Electron so it can be unit tested in isolation.
 */

export interface SnykClassification {
  status: PipelineSnykStatus;
  issues: string[];
  scaGating: 'gating' | 'non-gating' | 'n/a';
  org?: string;
}

export interface StackAnalysis {
  /** Raw pipeline name expression; template placeholders are resolved later. */
  pipelineNameExpr?: string;
  snykCommands: string[];
  stageNames: string[];
  actionNames: string[];
  hasGitSecrets: boolean;
  snyk: SnykClassification;
}

export interface CdkEnv {
  envKey: string;
  account: string;
  region: string;
  branch?: string;
}

const SKIP_DIRS = new Set(['node_modules', 'cdk.out', '.git', 'test', 'dist', '__pycache__']);

/** Finds `*pipeline-stack.ts` files (excluding .d.ts) under a repository. */
export async function findPipelineStacks(repoDir: string, maxDepth = 6): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.name.endsWith('pipeline-stack.ts') && !entry.name.endsWith('.d.ts')) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  await walk(repoDir, 0);
  return found.sort();
}

/** Collects single-line `const name = "literal";` definitions for inlining. */
function collectStringConsts(text: string): Map<string, string> {
  const consts = new Map<string, string>();
  const re = /\bconst\s+(\w+)\s*=\s*(["'`])([^"'`\n]*)\2\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) consts.set(m[1], m[3]);
  return consts;
}

/**
 * Extracts every string literal that is a `snyk ...` command. Simple
 * `${constName}` references to string constants in the same file are inlined,
 * so commands built from shared fragments classify the same as literal ones.
 */
export function extractSnykCommands(text: string): string[] {
  const consts = collectStringConsts(text);
  const inline = (cmd: string): string => {
    let out = cmd;
    for (let i = 0; i < 5 && out.includes('${'); i++) {
      const next = out.replace(/\$\{(\w+)\}/g, (whole, name: string) => consts.get(name) ?? whole);
      if (next === out) break;
      out = next;
    }
    return out;
  };
  const commands: string[] = [];
  const re = /(["'`])(snyk [^"'`\n]*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    commands.push(inline(m[2].trim()));
  }
  return commands;
}

function extractLiterals(text: string, key: string): string[] {
  const re = new RegExp(`${key}:\\s*(["'\`])([^"'\`\\n]+)\\1`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[2]);
  return out;
}

export function classifySnyk(text: string, commands: string[]): SnykClassification {
  if (commands.length === 0 && !/snyk/i.test(text)) {
    return { status: 'none', issues: ['No Snyk step in pipeline'], scaGating: 'n/a' };
  }

  const issues: string[] = [];
  const monitor = commands.filter((c) => c.startsWith('snyk monitor'));
  const sca = commands.filter((c) => c.startsWith('snyk test'));
  const code = commands.filter((c) => c.startsWith('snyk code test'));
  const scanCmds = [...monitor, ...sca, ...code];

  if (commands.length === 0) issues.push('Snyk is mentioned but no snyk commands were found');
  if (monitor.length === 0) issues.push('No `snyk monitor` (dashboard is not updated)');
  if (sca.length === 0) issues.push('No `snyk test` (SCA dependency scan missing)');
  if (code.length === 0) issues.push('No `snyk code test` (SAST missing)');
  else if (!code.some((c) => c.includes('--report'))) issues.push('`snyk code test` lacks --report');

  if (scanCmds.length > 0) {
    if (scanCmds.some((c) => !c.includes('--org='))) issues.push('Missing --org on a scan command');
    if (scanCmds.some((c) => /--remote-repo-url=https:\/\//.test(c))) {
      issues.push('https:// --remote-repo-url (use http:// or targets split)');
    }
    if (scanCmds.some((c) => !/--remote-repo-url=http:\/\//.test(c))) {
      issues.push('Missing http:// --remote-repo-url');
    }
    if (scanCmds.some((c) => !c.includes('--target-reference'))) {
      issues.push('Missing --target-reference (branches are not grouped)');
    }
    if (scanCmds.some((c) => c.includes('--project-name') && c.includes('--all-projects'))) {
      issues.push('--project-name with --all-projects (fatal flag combination)');
    }
  }

  const orgs = new Set<string>();
  for (const c of scanCmds) {
    const m = /--org=([\w-]+)/.exec(c);
    if (m) orgs.add(m[1]);
  }
  if (orgs.size > 1) issues.push(`Commands use different orgs: ${[...orgs].join(', ')}`);

  const scaGating: SnykClassification['scaGating'] =
    sca.length === 0 ? 'n/a' : sca.every((c) => !c.includes('|| true')) ? 'gating' : 'non-gating';

  return {
    status: issues.length > 0 ? 'partial' : 'ok',
    issues,
    scaGating,
    org: orgs.size > 0 ? [...orgs][0] : undefined,
  };
}

export function analyzeStack(text: string): StackAnalysis {
  const snykCommands = extractSnykCommands(text);
  const nameMatch = /pipelineName:\s*(?:(["'`])([^"'`\n]+)\1|([A-Za-z_][\w.]*))/.exec(text);
  let pipelineNameExpr: string | undefined;
  if (nameMatch) {
    if (nameMatch[2] !== undefined) {
      pipelineNameExpr = nameMatch[2];
    } else if (nameMatch[3]) {
      // A constant such as `NAMES.pipeline`: look for its literal definition.
      const prop = nameMatch[3].split('.').pop()!;
      const def = new RegExp(`\\b${prop}:\\s*(["'\`])([^"'\`\\n]+)\\1`).exec(text);
      pipelineNameExpr = def ? def[2] : undefined;
    }
  }
  return {
    pipelineNameExpr,
    snykCommands,
    stageNames: extractLiterals(text, 'stageName'),
    actionNames: extractLiterals(text, 'actionName'),
    hasGitSecrets: /git secrets|git-secrets/i.test(text),
    snyk: classifySnyk(text, snykCommands),
  };
}

/**
 * Resolves a pipeline name expression to a concrete name. Only the common
 * `${props.envKey}` placeholder is understood; anything else is unresolvable.
 */
export function resolvePipelineName(expr: string | undefined, envKey?: string): string | undefined {
  if (!expr) return undefined;
  if (!expr.includes('${')) return expr;
  if (!envKey) return undefined;
  const resolved = expr.replace(/\$\{(?:props\.)?envKey\}/g, envKey);
  return resolved.includes('${') ? undefined : resolved;
}

/** Reads the environments (test/prod/eu...) from the cdk.json nearest to a stack file. */
export async function readCdkEnvs(stackFile: string, repoDir: string): Promise<CdkEnv[]> {
  let dir = path.dirname(stackFile);
  const root = path.resolve(repoDir);
  for (;;) {
    try {
      const raw = await readFile(path.join(dir, 'cdk.json'), 'utf-8');
      const json = JSON.parse(raw) as { context?: Record<string, unknown> };
      const envs: CdkEnv[] = [];
      for (const [key, value] of Object.entries(json.context ?? {})) {
        if (value && typeof value === 'object') {
          const v = value as { account?: unknown; region?: unknown; pipeline?: { branch?: unknown } };
          if (typeof v.account === 'string' && typeof v.region === 'string') {
            envs.push({
              envKey: key,
              account: v.account,
              region: v.region,
              branch: typeof v.pipeline?.branch === 'string' ? v.pipeline.branch : undefined,
            });
          }
        }
      }
      return envs;
    } catch {
      // No (readable) cdk.json here; walk up until the repository root.
    }
    if (path.resolve(dir) === root) return [];
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

/** Extracts `snyk ...` commands from a deployed CodeBuild buildspec string. */
export function extractDeployedSnykCommands(buildspec: string | undefined): string[] {
  if (!buildspec) return [];
  const out: string[] = [];
  const collect = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.trim().startsWith('snyk ')) out.push(node.trim());
    } else if (Array.isArray(node)) {
      node.forEach(collect);
    } else if (node && typeof node === 'object') {
      Object.values(node).forEach(collect);
    }
  };
  try {
    collect(JSON.parse(buildspec));
  } catch {
    // Not JSON (hand-written YAML buildspec): fall back to line scanning.
    for (const line of buildspec.split('\n')) {
      const cleaned = line.trim().replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
      if (cleaned.startsWith('snyk ')) out.push(cleaned);
    }
  }
  return out;
}

/**
 * Turns a command from source into a matcher. `${...}` template placeholders
 * (e.g. the branch) match any non-space token in the deployed command.
 */
export function commandMatches(localCmd: string, deployedCmd: string): boolean {
  const parts = localCmd.split(/\$\{[^}]*\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('\\S+')}$`).test(deployedCmd.trim());
}

export interface DeployedPipelineShape {
  stageNames: string[];
  actionNames: string[];
  sourceBranch?: string;
  /** Snyk commands found in the deployed CodeBuild projects' buildspecs. */
  snykCommands: string[];
  hasSnykProject: boolean;
}

/** Lists the differences between the pipeline in code and the deployed one. */
export function compareWithDeployed(
  local: StackAnalysis,
  deployed: DeployedPipelineShape,
  expectedBranch?: string
): string[] {
  const diffs: string[] = [];
  const short = (c: string) => (c.length > 90 ? `${c.slice(0, 87)}...` : c);

  const staticNames = (names: string[]) => names.filter((n) => !n.includes('${'));
  const localStages = staticNames(local.stageNames);
  const localActions = staticNames(local.actionNames);
  if (localStages.length > 0) {
    for (const s of localStages.filter((n) => !deployed.stageNames.includes(n))) {
      diffs.push(`Stage "${s}" is in code but not deployed`);
    }
    for (const s of deployed.stageNames.filter((n) => !localStages.includes(n))) {
      diffs.push(`Stage "${s}" is deployed but not in code`);
    }
  }
  if (localActions.length > 0) {
    for (const a of localActions.filter((n) => !deployed.actionNames.includes(n))) {
      diffs.push(`Action "${a}" is in code but not deployed`);
    }
    for (const a of deployed.actionNames.filter((n) => !localActions.includes(n))) {
      diffs.push(`Action "${a}" is deployed but not in code`);
    }
  }

  if (expectedBranch && deployed.sourceBranch && deployed.sourceBranch !== expectedBranch) {
    diffs.push(`Source branch is "${deployed.sourceBranch}", cdk.json expects "${expectedBranch}"`);
  }

  if (local.snykCommands.length > 0 && !deployed.hasSnykProject) {
    diffs.push('Code has a Snyk scan but no deployed CodeBuild project runs Snyk');
  } else {
    for (const cmd of local.snykCommands) {
      if (!deployed.snykCommands.some((d) => commandMatches(cmd, d))) {
        diffs.push(`Deployed buildspec lacks: ${short(cmd)}`);
      }
    }
    for (const d of deployed.snykCommands) {
      if (!local.snykCommands.some((cmd) => commandMatches(cmd, d))) {
        diffs.push(`Deployed buildspec has extra/different: ${short(d)}`);
      }
    }
  }
  return diffs;
}
