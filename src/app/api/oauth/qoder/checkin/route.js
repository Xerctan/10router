import { NextResponse } from "next/server";

/**
 * POST /api/oauth/qoder/checkin
 * Trigger a manual Qoder daily credit claim for active connections.
 */
export async function POST() {
  try {
    const { runQoderCheckinTick } = await import(
      "@/sse/services/qoderCheckin.js"
    );
    const results = await runQoderCheckinTick({ skipIfCheckedToday: false });
    const qoderResults = results.filter((r) => r.provider === "qoder");
    return NextResponse.json({ success: true, results: qoderResults });
  } catch (error) {
    console.error("Error running Qoder check-in:", error.message);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
