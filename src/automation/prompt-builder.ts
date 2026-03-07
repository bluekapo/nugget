import type { ContextPacket } from './types.js';

export function buildPrompt(ctx: ContextPacket): string {
  const lines: string[] = [];

  // Task section
  lines.push('## Task');
  lines.push(ctx.taskDescription);
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

  // Directive instructions
  lines.push('## Your Response');
  lines.push('');
  lines.push('Respond with exactly ONE directive in the following format:');
  lines.push('');
  lines.push('- `COMMAND: <shell command>` -- Execute a shell command in the worker terminal');
  lines.push('- `SELECT: <number>` -- Select a numbered menu option (1-based)');
  lines.push('- `ENTER` -- Press Enter (confirm a prompt or continue)');
  lines.push('- `WAIT: <seconds>` -- Wait for the specified number of seconds before next cycle');
  lines.push('- `ESCALATE: <reason>` -- Stop automation and escalate to the human operator');
  lines.push('');
  lines.push('Guidelines:');
  lines.push('- Use COMMAND to run shell commands and advance the task');
  lines.push('- Use SELECT when the terminal shows a numbered menu');
  lines.push('- Use ENTER when a prompt is waiting for confirmation');
  lines.push('- Use WAIT when a long-running process needs time to complete');
  lines.push('- Use ESCALATE when the task is complete, something went wrong, or you are unsure how to proceed');

  return lines.join('\n');
}
