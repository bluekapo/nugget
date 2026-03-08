/**
 * CommandAllowlist validates input commands against a configurable set of patterns.
 *
 * Patterns are comma-separated strings, optionally containing `*` for glob matching.
 * When disabled (undefined or '*'), all commands are allowed.
 */
export class CommandAllowlist {
  private enabled: boolean;
  private patterns: RegExp[];
  private patternSources: string[];

  constructor(allowlistConfig: string | undefined) {
    if (allowlistConfig === undefined || allowlistConfig === '*') {
      this.enabled = false;
      this.patterns = [];
      this.patternSources = [];
      return;
    }

    const raw = allowlistConfig
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    this.patternSources = raw;
    this.patterns = raw.map((pattern) => {
      // Escape regex special chars except *, then replace * with .*
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      const regexStr = escaped.replace(/\*/g, '.*');
      return new RegExp(`^${regexStr}$`, 'i');
    });
    this.enabled = true;
  }

  /** Returns true if the input command is allowed (passes allowlist check). */
  isAllowed(input: string): boolean {
    if (!this.enabled) {
      return true;
    }
    const trimmed = input.trim();
    return this.patterns.some((re) => re.test(trimmed));
  }

  /** Returns a human-readable description of the allowlist configuration. */
  describe(): string {
    if (!this.enabled) {
      return '*';
    }
    return this.patternSources.join(', ');
  }
}
