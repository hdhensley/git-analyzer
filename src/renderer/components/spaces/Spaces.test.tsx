/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SpaceSwitcher } from './SpaceSwitcher';
import { SpacesManager } from './SpacesManager';
import type { SpaceSummary } from '../../../shared/types';
import type { ElectronAPI } from '../../../shared/types/electron-api';

const testWindow = () => globalThis.window as unknown as { electronAPI?: ElectronAPI };

const work: SpaceSummary = { id: 'default', name: 'Work', color: '#3b82f6', createdAt: '', active: true };
const personal: SpaceSummary = { id: 'sp_1', name: 'Personal', color: '#16a34a', createdAt: '', active: false };
const workConnected: SpaceSummary = {
  ...work,
  connections: { github: false, bitbucket: true, snyk: true },
};
const personalConnected: SpaceSummary = {
  ...personal,
  connections: { github: true, bitbucket: false, snyk: false },
};

function installApi(spaces: SpaceSummary[], overrides: Record<string, unknown> = {}) {
  const api = {
    spaces: {
      list: vi.fn().mockResolvedValue(spaces),
      getActive: vi.fn().mockResolvedValue(spaces.find((s) => s.active)),
      create: vi.fn().mockResolvedValue({ ...personal, id: 'sp_new', name: 'New', active: false }),
      rename: vi.fn().mockResolvedValue(work),
      switchTo: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      duplicate: vi.fn().mockResolvedValue({ ...personal, id: 'sp_copy', name: 'Copy', active: false }),
      export: vi.fn().mockResolvedValue('/tmp/Personal.db'),
      ...overrides,
    },
    // The first-run name prompt reads this; '1' means it was already shown.
    spaceSettings: { get: vi.fn().mockResolvedValue('1'), set: vi.fn().mockResolvedValue(undefined) },
  };
  testWindow().electronAPI = api as unknown as ElectronAPI;
  return api;
}

describe('SpaceSwitcher', () => {
  beforeEach(() => {
    document.title = '';
  });
  afterEach(() => {
    cleanup();
    delete testWindow().electronAPI;
    vi.clearAllMocks();
  });

  it('shows the active space and puts its name in the window title', async () => {
    installApi([work, personal]);
    render(<SpaceSwitcher onManage={() => {}} />);
    expect(await screen.findByText('Work')).toBeInTheDocument();
    expect(document.title).toBe('Git Analyzer · Work');
  });

  it('renders nothing when the spaces API is unavailable', () => {
    delete testWindow().electronAPI;
    const { container } = render(<SpaceSwitcher onManage={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists spaces in a menu and switches when another is chosen', async () => {
    const api = installApi([work, personal]);
    render(<SpaceSwitcher onManage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Work/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Personal/ }));
    await waitFor(() => expect(api.spaces.switchTo).toHaveBeenCalledWith('sp_1'));
  });

  it('does not switch when the active space is chosen', async () => {
    const api = installApi([work, personal]);
    render(<SpaceSwitcher onManage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Work/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Work/ }));
    expect(api.spaces.switchTo).not.toHaveBeenCalled();
  });

  it('shows the reason when a switch is refused', async () => {
    installApi([work, personal], {
      switchTo: vi
        .fn()
        .mockRejectedValue(
          new Error("Error invoking remote method 'spaces:switch': Error: Cannot switch spaces while a sync is in progress.")
        ),
    });
    render(<SpaceSwitcher onManage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Work/ }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Personal/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Cannot switch spaces while a sync is in progress.'
    );
  });

  it('opens the manage view from the menu', async () => {
    const onManage = vi.fn();
    installApi([work, personal]);
    render(<SpaceSwitcher onManage={onManage} />);
    fireEvent.click(await screen.findByRole('button', { name: /Work/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Manage spaces/ }));
    expect(onManage).toHaveBeenCalled();
  });

  it('creates a space and switches to it', async () => {
    const api = installApi([work, personal]);
    render(<SpaceSwitcher onManage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Work/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /New space/ }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Side projects' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and switch' }));
    await waitFor(() => expect(api.spaces.create).toHaveBeenCalledWith('Side projects', expect.any(String)));
    await waitFor(() => expect(api.spaces.switchTo).toHaveBeenCalledWith('sp_new'));
  });

  it('invites naming a lone "Default" space once, and remembers the answer', async () => {
    const lone: SpaceSummary = { ...work, name: 'Default' };
    const api = installApi([lone]);
    api.spaceSettings.get.mockResolvedValue(null);
    render(<SpaceSwitcher onManage={() => {}} />);
    expect(await screen.findByRole('dialog', { name: 'Name this space' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(api.spaceSettings.set).toHaveBeenCalledWith('spaceNamePrompted', '1'));
  });

  it('does not prompt once the flag is set', async () => {
    installApi([{ ...work, name: 'Default' }]);
    render(<SpaceSwitcher onManage={() => {}} />);
    await screen.findByText('Default');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows connection chips next to each space in the menu', async () => {
    installApi([workConnected, personalConnected]);
    render(<SpaceSwitcher onManage={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Work/ }));
    expect(await screen.findByLabelText('Connected: Bitbucket, Snyk')).toBeInTheDocument();
    expect(screen.getByLabelText('Connected: GitHub')).toBeInTheDocument();
  });
});

describe('SpacesManager', () => {
  afterEach(() => {
    cleanup();
    delete testWindow().electronAPI;
    vi.clearAllMocks();
  });

  it('lists spaces and disables deleting the active one', async () => {
    installApi([work, personal]);
    render(<SpacesManager />);
    expect(await screen.findByText('Personal')).toBeInTheDocument();
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    expect(deleteButtons[0]).toBeDisabled(); // Work is active
    expect(deleteButtons[1]).toBeEnabled();
  });

  it('requires typing the space name before deleting', async () => {
    const api = installApi([work, personal]);
    render(<SpacesManager />);
    await screen.findByText('Personal');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[1]);

    const confirm = await screen.findByRole('button', { name: 'Delete space' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Persona' } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: 'Personal' } });
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    await waitFor(() => expect(api.spaces.delete).toHaveBeenCalledWith('sp_1'));
  });

  it('renames a space', async () => {
    const api = installApi([work, personal]);
    render(<SpacesManager />);
    await screen.findByText('Personal');
    fireEvent.click(screen.getAllByRole('button', { name: 'Rename' })[1]);
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Home' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.spaces.rename).toHaveBeenCalledWith('sp_1', 'Home', '#16a34a'));
  });

  it('shows which services are connected in each space', async () => {
    installApi([workConnected, personalConnected]);
    render(<SpacesManager />);
    await screen.findByText('Personal');
    expect(screen.getByLabelText('Connected: Bitbucket, Snyk')).toBeInTheDocument();
    expect(screen.getByLabelText('Connected: GitHub')).toBeInTheDocument();
  });

  it('says so when a space has nothing connected', async () => {
    installApi([{ ...personal, active: true, connections: { github: false, bitbucket: false, snyk: false } }]);
    render(<SpacesManager />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });

  it('duplicates a space with a suggested name', async () => {
    const api = installApi([work, personal]);
    render(<SpacesManager />);
    await screen.findByText('Personal');
    fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate' })[1]);
    const input = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(input.value).toBe('Personal copy');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(api.spaces.duplicate).toHaveBeenCalledWith('sp_1', 'Personal copy', '#16a34a'));
  });

  it('exports a space and reports where it was saved', async () => {
    const api = installApi([work, personal]);
    render(<SpacesManager />);
    await screen.findByText('Personal');
    fireEvent.click(screen.getAllByRole('button', { name: 'Export' })[1]);
    await waitFor(() => expect(api.spaces.export).toHaveBeenCalledWith('sp_1'));
    expect(await screen.findByRole('status')).toHaveTextContent('/tmp/Personal.db');
  });

  it('stays quiet when the export dialog is cancelled', async () => {
    installApi([work, personal], { export: vi.fn().mockResolvedValue(null) });
    render(<SpacesManager />);
    await screen.findByText('Personal');
    fireEvent.click(screen.getAllByRole('button', { name: 'Export' })[1]);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });
});
