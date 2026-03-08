export type SessionStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export interface Session {
  id: number;
  name: string;
  pid: number | null;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
}
