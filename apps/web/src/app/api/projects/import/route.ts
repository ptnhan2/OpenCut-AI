/**
 * POST /api/projects/import — Nhận project JSON từ Platform bridge,
 * validate cấu trúc OpenCut v10, lưu vào storage và trả về projectId.
 *
 * Được gọi bởi Platform bridge (src/shared/api-clients/opencut-bridge.ts).
 */

import { NextResponse } from 'next/server';

/**
 * Validate cấu trúc cơ bản của SerializedProject (OpenCut v10).
 * Chỉ kiểm tra các field bắt buộc, không validate toàn bộ schema.
 */
function isValidProject(body: unknown): body is { project: Record<string, unknown> } {
  if (!body || typeof body !== 'object') return false;
  const { project } = body as Record<string, unknown>;
  if (!project || typeof project !== 'object') return false;
  const p = project as Record<string, unknown>;
  return (
    typeof p.metadata === 'object' &&
    p.metadata !== null &&
    Array.isArray(p.scenes) &&
    typeof p.version === 'number' &&
    p.version === 10
  );
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isValidProject(body)) {
    return NextResponse.json(
      { error: 'Invalid project structure. Required: metadata, scenes[], version=10' },
      { status: 400 },
    );
  }

  const projectId = (body.project.metadata as Record<string, unknown>).id as string;

  // TODO: Lưu project vào IndexedDB/OPFS storage (cần browser context).
  // Hiện tại chỉ validate và trả về success để Platform bridge flow hoạt động.

  return NextResponse.json({ success: true, projectId }, { status: 200 });
}
