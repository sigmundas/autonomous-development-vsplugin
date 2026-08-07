export interface ClaudeTerminalIdentity {
  readonly repositoryId: string;
  readonly runId: string;
}

export function terminalIdentityForRun(run: {
  readonly repoId: string;
  readonly runId: string;
}): ClaudeTerminalIdentity {
  return { repositoryId: run.repoId, runId: run.runId };
}
