export type ApiOwner = { id: string; email: string; role: 'admin' | 'user'; sessionId: string };
export type ApiRequest = {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string | undefined>;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  ip: string;
  owner?: ApiOwner;
  csrfToken?: string;
  log: { error(details: unknown, message: string): void };
};
export type CookieOptions = {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  maxAge?: number;
};
export type ApiReply = {
  sent: boolean;
  code(status: number): ApiReply;
  send(value?: unknown): ApiReply;
  setCookie(name: string, value: string, options?: CookieOptions): ApiReply;
  clearCookie(name: string, options?: CookieOptions): ApiReply;
  header(name: string, value: string): ApiReply;
  type(value: string): ApiReply;
};
export type ApiHandler = (request: ApiRequest, reply: ApiReply) => unknown | Promise<unknown>;
export type ApiHook = (request: ApiRequest, reply: ApiReply) => unknown | Promise<unknown>;
export type ApiApp = {
  get(path: string, handler: ApiHandler): void;
  post(path: string, handler: ApiHandler): void;
  put(path: string, handler: ApiHandler): void;
  patch(path: string, handler: ApiHandler): void;
  delete(path: string, handler: ApiHandler): void;
  addHook(name: 'preHandler', hook: ApiHook): void;
  swagger(): object;
};
export type InjectResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json(): unknown;
};
export type ApiTestApp = ApiApp & {
  inject(options: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<InjectResponse>;
  handle(request: Request): Promise<Response>;
  ready(): Promise<void>;
  close(): Promise<void>;
};
