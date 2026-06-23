/**
 * POST /api/media/import — Nhận media file từ Platform bridge,
 * validate và trả về mediaId đã đăng ký.
 *
 * Được gọi bởi Platform bridge (src/shared/api-clients/opencut-bridge.ts).
 *
 * TODO: Lưu file vào OPFS storage (cần browser context).
 * Hiện tại chỉ validate form data và trả về success.
 */

import { NextResponse } from 'next/server';

export async function POST(req: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const projectId = formData.get('projectId');
  const mediaId = formData.get('mediaId');
  const file = formData.get('file');

  if (!projectId || typeof projectId !== 'string') {
    return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
  }
  if (!mediaId || typeof mediaId !== 'string') {
    return NextResponse.json({ error: 'Missing mediaId' }, { status: 400 });
  }
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file' }, { status: 400 });
  }

  // TODO: Lưu file vào OPFS/proxy storage.
  // Hiện tại chỉ validate và trả về mediaId.

  return NextResponse.json({ success: true, mediaId }, { status: 200 });
}
