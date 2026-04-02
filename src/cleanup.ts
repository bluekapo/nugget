/**
 * Shared session cleanup logic.
 *
 * Extracted so the same cleanup behavior can be used by:
 * - session:exit bus handler (local session exits)
 * - onUnregister IPC callback (remote session exits)
 * - Tests (verifying cleanup parity)
 */

export interface CleanupRouter {
  activeSession: string | null;
  remove(name: string): void;
  getAll(): string[];
  switchTo(name: string): void;
}

export interface CleanupHubRenderer {
  clearExecState(name: string): void;
  render(): void;
}

export interface CleanupCompletionTracker {
  removeSession(name: string): void;
}

export interface CleanupEmulator {
  dispose(): void;
}

/**
 * Creates a session cleanup function that performs all necessary teardown:
 * 1. Removes session from router
 * 2. Clears exec state in hub renderer
 * 3. Removes session from completion tracker
 * 4. Disposes and removes emulator
 * 5. Auto-switches to next session if the cleaned session was active
 * 6. Re-renders hub
 */
export function makeCleanupSession(
  router: CleanupRouter,
  hubRenderer: CleanupHubRenderer,
  completionTracker: CleanupCompletionTracker,
  emulators: Map<string, CleanupEmulator>,
): (name: string) => void {
  return (name: string): void => {
    const wasActive = router.activeSession === name;
    router.remove(name);
    hubRenderer.clearExecState(name);
    completionTracker.removeSession(name);

    const emu = emulators.get(name);
    if (emu) {
      emu.dispose();
      emulators.delete(name);
    }

    // Auto-switch to next available session if the cleaned one was active
    if (wasActive && router.activeSession === null && router.getAll().length > 0) {
      router.switchTo(router.getAll()[0]);
    }

    hubRenderer.render();
  };
}
