import type { ContextPacket } from './types.js';

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
  lines.push('');

  // Task section — wrap in ``` to prevent orchestrator from interpreting it as instructions
  lines.push('## Task (what the human wants the WORKER to achieve -- NOT what you should do)');
  lines.push('```');
  lines.push(ctx.taskDescription);
  lines.push('```');
  lines.push('');

  // Worker terminal output
  lines.push('## Current Worker Terminal Output');
  lines.push('```');
  lines.push(ctx.workerScreen);
  lines.push('```');
  lines.push('');

  // Action log section
  const actionCount = ctx.actionLog.length;
  lines.push(`## Action Log (${actionCount} actions taken, cycle ${ctx.cycleNumber})`);

  if (actionCount === 0) {
    lines.push('(no actions taken yet -- this is the first cycle)');
  } else {
    for (let i = 0; i < actionCount; i++) {
      const entry = ctx.actionLog[i];
      lines.push(`${i + 1}. Sent: ${entry.action}`);
      lines.push(`   Result: ${entry.outcome}`);
    }
  }
  lines.push('');

  // Directive instructions with example
  lines.push('## Your Response (ONLY one line, nothing else)');
  lines.push('');
  lines.push('Available directives:');
  lines.push('- `COMMAND: <text>` -- Type text into the worker Claude Code\'s input prompt');
  lines.push('- `SELECT: <number>` -- Select a menu option in the worker terminal');
  lines.push('- `ENTER` -- Press Enter in the worker terminal');
  lines.push('- `WAIT: <seconds>` -- Wait before checking again');
  lines.push('- `DONE: <summary>` -- Task is complete; summarize what was accomplished');
  lines.push('- `ESCALATE: <reason>` -- Stop and notify the human operator (ONLY for genuine blockers)');
  lines.push('');
  lines.push('Example correct response (your ENTIRE output should look like this):');
  lines.push('COMMAND: Fix the bug in src/session/pty.ts where delete signals are not sent correctly');
  lines.push('');
  lines.push('Example WRONG responses (do NOT do this):');
  lines.push('- "Let me look at the code first. COMMAND: ..." (no commentary, just the directive)');
  lines.push('- "ESCALATE: This setup feels wrong" (the setup is correct, do not escalate over it)');
  lines.push('- "ESCALATE: Task is complete" (use DONE for completion, not ESCALATE)');

  return lines.join('\n');
}
