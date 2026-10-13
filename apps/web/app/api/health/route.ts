import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ status: 'ok', app: 'zarghamflow-next', time: new Date().toISOString() });
}
