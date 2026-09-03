export interface MessageEvent {
  message: { text: string; logId?: string | number; id?: string | number; [key: string]: any };
  sender: { id: string | number; name: string; type?: any; [key: string]: any };
  room: { id: string | number; name: string; [key: string]: any };
  raw?: any;
  [key: string]: any;
}

export interface MemberEvent {
  member?: { ids?: Array<string | number>; names?: string[]; [key: string]: any };
  room: { id: string | number; name: string; [key: string]: any };
  [key: string]: any;
}

export interface KakaoForgeClient {
  userId: string | number;
  connected: boolean;
  type?: string;
  transport?: string;
  constructor: any;
  onReady(handler: (chat: any) => void): any;
  onMessage(handler: (chat: any, event: MessageEvent) => void | Promise<void>): any;
  onJoin(handler: (chat: any, event: MemberEvent) => void | Promise<void>): any;
  onLeave(handler: (chat: any, event: MemberEvent) => void | Promise<void>): any;
  onKick(handler: (chat: any, event: MemberEvent) => void | Promise<void>): any;
  on(event: string, handler: (error: any) => void): any;
  disconnect?: () => void;
  [key: string]: any;
}

export type AuthPayload = {
  userId: number | string;
  accessToken: string;
  refreshToken?: string;
  deviceUuid: string;
  savedAt?: string;
  raw?: unknown;
  authPath?: string;
};
