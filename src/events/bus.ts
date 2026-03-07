import { EventEmitter } from 'node:events';

export interface BusEvents {
  'session:output': (sessionName: string, data: string) => void;
  'session:exit': (sessionName: string, exitCode: number) => void;
  'session:started': (sessionName: string) => void;
  'session:exec-state': (sessionName: string, state: 'busy' | 'idle') => void;
  'automation:state-change': (state: string, detail?: string) => void;
  'automation:cycle-complete': (cycleNumber: number, action: string) => void;
  'automation:escalation': (reason: string) => void;
  'automation:error': (error: string) => void;
}

export class EventBus {
  private emitter = new EventEmitter();

  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.emitter.emit(event, ...args);
  }

  off<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): void {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
  }
}
