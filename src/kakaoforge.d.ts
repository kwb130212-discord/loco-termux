declare module 'kakaoforge' {
  export interface AuthPayload {
    userId: number;
    accessToken: string;
    refreshToken?: string;
    deviceUuid: string;
    savedAt?: string;
    raw?: unknown;
    authPath?: string;
  }

  export interface CreateAuthByQROptions {
    authPath?: string;
    deviceUuid?: string;
    deviceName?: string;
    modelName?: string;
    forced?: boolean;
    checkAllowlist?: boolean;
    enforceAllowlist?: boolean;
    appVer?: string;
    onQrUrl?: (url: string) => void;
    onPasscode?: (passcode: string) => void;
    save?: boolean;
  }

  export function createAuthByQR(options?: CreateAuthByQROptions): Promise<AuthPayload>;
  export function createClient(config?: Record<string, unknown>): any;
}
