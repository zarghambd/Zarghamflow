import { handleApiRequest } from '../../../../server/dist/http.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: Request) {
  return handleApiRequest(request);
}
