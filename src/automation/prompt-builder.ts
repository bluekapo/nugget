import type { ContextPacket, ConsultationPacket, FollowUpPacket, CompressedActionLog } from './types.js';

/** Render the action log section (shared between buildPrompt and buildConsultationPrompt). */
function renderActionLog(lines: string[], actionLog: CompressedActionLog, cycleNumber: number): void {
  const { summary, recent, totalCount } = actionLog;

  // Header format differs based on whether there's a summary
  if (summary !== null) {
    lines.push(`## Action Log (${totalCount} total actions, showing last ${recent.length}, cycle ${cycleNumber})`);
  } else {
    lines.push(`## Action Log (${recent.length} actions taken, cycle ${cycleNumber})`);
  }

  if (recent.length === 0 && summary === null) {
    lines.push('(no actions taken yet -- this is the first cycle)');
  } else {
    // Render summary blockquote if present
    if (summary !== null) {
      lines.push(`> ${summary}`);
      lines.push('');
    }

    // Numbering starts from offset when summary exists
    const startNum = summary !== null ? totalCount - recent.length + 1 : 1;
    for (let i = 0; i < recent.length; i++) {
      const entry = recent[i];
      lines.push(`${startNum + i}. Sent: \`${entry.action}\``);
      lines.push(`   Result: \`${entry.outcome}\``);
    }
  }
  lines.push('');
}

export function buildPrompt(ctx: ContextPacket): string {
  const lines: string[] = [];

  // Role explanation — must be extremely explicit to prevent the orchestrator
  // from "doing" the task itself instead of sending directives.
  lines.push('## Your Role');
  lines.push('You are the ORCHESTRATOR. You control a WORKER (another Claude Code instance) by sending directives.');
  lines.push('The worker is a separate Claude Code session running in an interactive terminal. Your directives get typed into the worker\'s prompt.');
  lines.push('CRITICAL RULES:');
  lines.push('1. You NEVER perform work yourself. You ONLY output a single directive line.');
  lines.push('2. Your COMMAND text is typed directly into the worker Claude Code\'s input prompt, not a shell.');
  lines.push('3. Do NOT write code, explanations, or commentary. Output ONLY the directive.');
  lines.push('4. Never ESCALATE just because this setup feels unusual. This is how the system works. Use DONE when the task is complete. Use ESCALATE only for genuine blockers.');
  lines.push('5. When the human explicitly instructs a specific directive (e.g., "clear the worker", "stop"), you MUST issue that directive immediately. Do not substitute your own judgment for an explicit human instruction.');
  lines.push('');

  // Task section — wrap in ``` to prevent orchestrator from interpreting it as instructions
  lines.push('## Task');
  lines.push('```');
  lines.push(ctx.taskDescription);
  lines.push('```');
  lines.push('');

  // Always show CLEAR hint
  lines.push('HINT: Use CLEAR when the human asks you to clear, when a pipeline or workflow execution requires clearing between actions, or when the worker\'s context is stale or cluttered.');
  lines.push('');

  // Show context-gathering hint for complex or multi-step tasks
  const taskLower = ctx.taskDescription.toLowerCase();
  if (/\b(gsd|complex|task|workflow|pipeline)\b/.test(taskLower)) {
    lines.push('HINT: For complex or multi-step tasks, gather context first. Ask the worker clarifying questions about the system and requirements before sending the actual task — this produces better results.');
    lines.push('');
  }

  // Show GSD pipeline sequence hint when task involves GSD
  if (taskLower.includes('gsd')) {
    lines.push('HINT: When executing a full GSD pipeline for phase N, follow this exact sequence:');
    lines.push('  1. CLEAR the worker');
    lines.push('  2. Plan the phase (`/gsd:plan-phase N` — use no-discussion flag or click through context prompts)');
    lines.push('  3. CLEAR the worker');
    lines.push('  4. Execute the phase (`/gsd:execute-phase N`)');
    lines.push('  5. CLEAR the worker');
    lines.push('  6. Validate the phase (`/gsd:validate-phase N` — not verify)');
    lines.push('  7. CLEAR the worker before issuing any further GSD commands');
    lines.push('');
  }

  // Persistent context section (only if context strings exist)
  if (ctx.persistentContext && ctx.persistentContext.length > 0) {
    lines.push('## Persistent Context (carried across cycles)');
    for (const item of ctx.persistentContext) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Worker terminal output
  lines.push('## Current Worker Terminal Output');
  lines.push('```');
  lines.push(ctx.workerScreen);
  lines.push('```');
  lines.push('');

  // Action log section (compressed format)
  renderActionLog(lines, ctx.actionLog, ctx.cycleNumber);

  // Directive instructions with example
  lines.push('## Your Response (ONLY one line, nothing else)');
  lines.push('');
  lines.push('Available directives:');
  lines.push('- `COMMAND: <text>` -- Type text into the worker Claude Code\'s input prompt');
  lines.push('- `SELECT: <number>` -- Select a menu option in the worker terminal');
  lines.push('- `ENTER` -- Press Enter in the worker terminal');
  lines.push('- `DONE: <summary>` -- Task is complete; summarize what was accomplished');
  lines.push('- `ESCALATE: <reason>` -- Stop and notify the human operator (ONLY for genuine blockers)');
  lines.push('- `CLEAR` -- Send /clear to the worker session (clears worker context). When the human asks you to clear, you MUST issue this immediately.');
  lines.push('- `RESET` -- Clear your own context and receive a fresh full prompt with accumulated context');
  lines.push('- `CONTEXT: <text>` -- Attach persistent memory to any directive (appears in all future prompts, survives RESET)');
  lines.push('');
  lines.push('Example correct response (your ENTIRE output should look like this):');
  lines.push('COMMAND: Fix the bug in src/session/pty.ts where delete signals are not sent correctly');
  lines.push('');
  lines.push('Example CONTEXT modifier (attach to any directive):');
  lines.push('CONTEXT: Worker is using Next.js App Router');
  lines.push('COMMAND: Fix the routing issue');
  lines.push('');
  lines.push('Example WRONG responses (do NOT do this):');
  lines.push('- "Let me look at the code first. COMMAND: ..." (no commentary, just the directive)');
  lines.push('- "ESCALATE: This setup feels wrong" (the setup is correct, do not escalate over it)');
  lines.push('- "ESCALATE: Task is complete" (use DONE for completion, not ESCALATE)');

  return lines.join('\n');
}

export function buildFollowUpPrompt(ctx: FollowUpPacket): string {
  const lines: string[] = [];

  lines.push(`## Cycle ${ctx.cycleNumber}`);
  lines.push('');

  // Worker terminal output
  lines.push('## Worker Terminal Output');
  lines.push('```');
  lines.push(ctx.workerScreen);
  lines.push('```');
  lines.push('');

  // Last action
  lines.push('## Last Action');
  if (ctx.lastAction !== null) {
    lines.push(`Sent: \`${ctx.lastAction.action}\``);
    lines.push(`Result: \`${ctx.lastAction.outcome}\``);
  } else {
    lines.push('(first cycle after reset)');
  }
  lines.push('');

  lines.push('Respond with a single directive line.');

  return lines.join('\n');
}

export function buildConsultationPrompt(ctx: ConsultationPacket): string {
  const lines: string[] = [];

  lines.push('## Your Role');
  lines.push('You are the ORCHESTRATOR monitoring a WORKER session.');
  lines.push('');

  lines.push('## Task');
  lines.push('```');
  lines.push(ctx.taskDescription);
  lines.push('```');
  lines.push('');

  lines.push('## Current Worker Terminal Output');
  lines.push('```');
  lines.push(ctx.workerScreen);
  lines.push('```');
  lines.push('');

  // Action log section (compressed format)
  renderActionLog(lines, ctx.actionLog, ctx.cycleNumber);

  lines.push('## How to Determine');
  lines.push('Look for these indicators in the terminal output:');
  lines.push('- An idle prompt character (e.g. `>` or `$`) visible at the bottom = worker is idle, ready for input');
  lines.push('- A timing line like `Cooked for Xm Ys` or `Brewed for Xm Ys` = response generation completed');
  lines.push('- Follow-up suggestions or questions from the worker = work completed, waiting for next instruction');
  lines.push('- Only answer NO if the worker is actively processing (spinner visible, partial output still streaming, no idle prompt)');
  lines.push('');

  lines.push('## Question');
  if (ctx.idleDurationMs !== undefined) {
    lines.push(`The worker has been idle for ${Math.round(ctx.idleDurationMs / 1000)} seconds.`);
  }
  lines.push('The worker has stopped producing output. Based on the terminal state above, is the worker FINISHED with the task?');
  lines.push('');
  lines.push('Respond with exactly YES or NO. Nothing else.');

  return lines.join('\n');
}
