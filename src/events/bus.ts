import { EventEmitter } from 'node:events';
import { logDebug } from '../logging/logger.js';

export interface BusEvents {
  'session:output': (sessionName: string, data: string) => void;
  'session:exit': (sessionName: string, exitCode: number) => void;
  'session:started': (sessionName: string) => void;
  'session:exec-state': (sessionName: string, state: 'busy' | 'idle') => void;
  'automation:state-change': (engineId: string, state: string, detail?: string) => void;
  'automation:cycle-complete': (engineId: string, cycleNumber: number, action: string) => void;
  'automation:escalation': (engineId: string, reason: string) => void;
  'automation:done': (engineId: string, summary: string) => void;
  'automation:warning': (engineId: string, message: string) => void;
  'automation:error': (engineId: string, error: string) => void;
}

export class EventBus {
  private emitter = new EventEmitter();

  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    // Log all events except high-frequency session:output to avoid log spam
    if (event !== 'session:output') {
      logDebug(`[bus] emit('${event}', ${args.map(a => typeof a === 'string' ? `'${a}'` : String(a)).join(', ')})`);
    }
    this.emitter.emit(event, ...args);
  }

  off<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  removeAllListeners<K extends keyof BusEvents>(event?: K): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  listenerCount<K extends keyof BusEvents>(event: K): number {
    return this.emitter.listenerCount(event);
  }

  once<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): void {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
  }
}
