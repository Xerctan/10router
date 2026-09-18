import { NextResponse } from "next/server";

/**
 * POST /api/oauth/qoder-cn/checkin
 * Trigger a manual Qoder CN daily credit claim for active connections.
 */
export async function POST() {
  try {
    const { runQoderCheckinTick } = await import(
      "@/sse/services/qoderCheckin.js"
    );
    const results = await runQoderCheckinTick({ skipIfCheckedToday: false });
    const qoderCnResults = results.filter((r) => r.provider === "qoder-cn");
    return NextResponse.json({ success: true, results: qoderCnResults });
  } catch (error) {
    console.error("Error running Qoder CN check-in:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
