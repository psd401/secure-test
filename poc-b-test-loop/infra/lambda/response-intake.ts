import type { APIGatewayProxyHandlerV2 } from "aws-lambda";

// Pass-through receiver for PoC-B student responses. Slice 9 added
// per-type discrimination on the wire so the log line tells the operator
// at a glance which item_type a given response covers and which value
// field carries the answer. The Lambda still doesn't persist anything —
// CloudWatch logs are the storage.

interface ResponseBody {
  test_id?: string;
  item_id?: string;
  item_type?: string;
  choice_id?: string;
  choice_ids?: string[];
  answer?: string;
  answered_at?: string;
}

function summarize(body: ResponseBody | null): string {
  if (!body) return "<empty body>";
  const itemType = body.item_type ?? "multiple_choice_single";
  const itemId = body.item_id ?? "<no-item-id>";
  switch (itemType) {
    case "multiple_choice_single":
      return `single-select item=${itemId} choice=${body.choice_id ?? "<missing>"}`;
    case "multiple_choice_multi": {
      const ids = body.choice_ids;
      const list = Array.isArray(ids) ? `[${ids.join(",")}]` : "<missing>";
      return `multi-select  item=${itemId} choices=${list}`;
    }
    case "short_text": {
      const answer = body.answer;
      const preview =
        typeof answer === "string"
          ? `"${answer.slice(0, 64)}"${answer.length > 64 ? "…" : ""}`
          : "<missing>";
      return `short-text   item=${itemId} answer=${preview}`;
    }
    default:
      return `unknown-type=${itemType} item=${itemId}`;
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  let body: ResponseBody | null = null;
  try {
    body = event.body ? (JSON.parse(event.body) as ResponseBody) : null;
  } catch {
    console.warn("response intake: invalid JSON body");
  }
  console.log("response intake:", summarize(body), "raw:", JSON.stringify(body));
  return {
    statusCode: 202,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, received_at: new Date().toISOString() }),
  };
};
