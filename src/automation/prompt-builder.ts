import type { ContextPacket, ConsultationPacket, FollowUpPacket, CompressedActionLog } from './types.js';
import { logDebug } from '../logging/logger.js';

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
  logDebug(`[prompt-builder] buildPrompt(cycle=${ctx.cycleNumber}, workerScreen=${ctx.workerScreen.length} chars)`);
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
  lines.push('6. NEVER use DONE while the worker is actively processing. If the terminal shows running agents, spinners (\'Frolicking...\', \'Crunching...\', etc.), progress indicators, or \'esc to interrupt\' — the worker has NOT finished. Wait for the next cycle. DONE terminates the automation permanently.');
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
  lines.push('- `DONE: <summary>` -- Task is FULLY complete (TERMINATES automation). Only use when the ENTIRE task is finished — never while the worker is still processing');
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
  lines.push('- "DONE: Waiting for X to complete" (DONE means FINISHED — it terminates the automation. If the worker is still processing, wait)');

  return lines.join('\n');
}

export function buildFollowUpPrompt(ctx: FollowUpPacket): string {
  logDebug(`[prompt-builder] buildFollowUpPrompt(cycle=${ctx.cycleNumber})`);
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

  lines.push('CRITICAL: If the worker is still processing (spinners, running agents, \'esc to interrupt\'), do NOT use DONE. DONE terminates the automation permanently. Wait for the worker to finish.');
  lines.push('');
  lines.push('Respond with a single directive line.');

  return lines.join('\n');
}

export function buildConsultationPrompt(ctx: ConsultationPacket): string {
  logDebug(`[prompt-builder] buildConsultationPrompt(cycle=${ctx.cycleNumber}, idleDuration=${ctx.idleDurationMs}ms)`);
  const lines: string[] = [];

  lines.push('## Your Role');
  lines.push('You are the ORCHESTRATOR answering a YES/NO question about worker status.');
  lines.push('CRITICAL: This is a STATUS CHECK, not a task. You must NOT:');
  lines.push('- Read files, search code, or run commands');
  lines.push('- Investigate the project or try to understand the codebase');
  lines.push('- Perform any work related to the task description below');
  lines.push('- Use ANY tools (Read, Bash, Grep, Glob, etc.)');
  lines.push('You are ONLY determining if the worker\'s terminal shows it has finished.');
  lines.push('Your ENTIRE response must be the single word YES or the single word NO.');
  lines.push('');

  lines.push('## Task (for reference only — do NOT act on this)');
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
  lines.push('Look ONLY at the terminal output above for these indicators:');
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
  lines.push('RESPOND WITH EXACTLY ONE WORD: YES or NO. Nothing else.');
  lines.push('Do not explain. Do not use tools. Do not investigate.');

  return lines.join('\n');
}
