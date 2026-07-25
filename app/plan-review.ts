import { App } from "@modelcontextprotocol/ext-apps";

interface ReviewStep {
  position: number;
  step_id: string;
  operation_id: string;
  summary: string;
  operation_count: number;
  outputs: Array<{ ref: string; name: string; entity_type: string; display: string }>;
}

interface ReviewData {
  status: string;
  plan_id: string;
  plan_version: number;
  expires_at: string;
  operation_count: number;
  steps: ReviewStep[];
  commit: { tool: "commit_inventory_plan"; arguments: { plan_id: string; expected_version: number } };
}

const app = new App({ name: "InvenTree inventory plan review", version: "1.0.0" });
const planMeta = requiredElement("plan-meta");
const stepsElement = requiredElement("steps");
const warning = requiredElement("warning");
const approval = requiredElement("approval");
const confirmed = requiredElement<HTMLInputElement>("confirmed");
const commitButton = requiredElement<HTMLButtonElement>("commit");
const statusElement = requiredElement("status");
let review: ReviewData | undefined;

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing app element: ${id}`);
  return element as T;
}

function reviewData(value: unknown): ReviewData | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const candidate = data as Partial<ReviewData>;
  return typeof candidate.plan_id === "string" && Array.isArray(candidate.steps) && candidate.commit
    ? candidate as ReviewData
    : undefined;
}

function addStep(step: ReviewStep): void {
  const section = document.createElement("section");
  section.className = "step";
  const number = document.createElement("span");
  number.className = "step-number";
  number.textContent = String(step.position);
  const details = document.createElement("div");
  const summary = document.createElement("pre");
  summary.className = "summary";
  summary.textContent = step.summary;
  details.append(summary);
  if (step.outputs.length) {
    const outputs = document.createElement("ul");
    outputs.className = "outputs";
    for (const output of step.outputs) {
      const item = document.createElement("li");
      item.textContent = `Creates ${output.display} (${output.entity_type}, ref ${output.ref})`;
      outputs.append(item);
    }
    details.append(outputs);
  }
  const metadata = document.createElement("p");
  metadata.className = "muted";
  metadata.textContent = `${step.operation_count} upstream operation${step.operation_count === 1 ? "" : "s"} · step ${step.step_id}`;
  details.append(metadata);
  section.append(number, details);
  stepsElement.append(section);
}

function render(data: ReviewData): void {
  review = data;
  stepsElement.replaceChildren();
  planMeta.textContent = `Plan ${data.plan_id} · version ${data.plan_version} · ${data.steps.length} change${data.steps.length === 1 ? "" : "s"} · expires ${new Date(data.expires_at).toLocaleString()}`;
  for (const step of data.steps) addStep(step);
  warning.hidden = data.operation_count <= 1;
  approval.hidden = data.status !== "staging" || data.steps.length === 0;
  confirmed.checked = false;
  commitButton.disabled = true;
  commitButton.textContent = `Commit ${data.steps.length} change${data.steps.length === 1 ? "" : "s"}`;
  setStatus(data.status === "staging" ? "" : `This plan is ${data.status} and cannot be committed here.`);
}

function textResult(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return "The tool call failed.";
  const text = result.content.find((item): item is { type: "text"; text: string } =>
    Boolean(item && typeof item === "object" && (item as { type?: unknown }).type === "text"));
  return text?.text ?? "The tool call failed.";
}

function setStatus(message: string, kind?: "error" | "success"): void {
  statusElement.textContent = message;
  statusElement.className = kind ?? "";
}

confirmed.addEventListener("change", () => {
  commitButton.disabled = !confirmed.checked || !review;
});

commitButton.addEventListener("click", async () => {
  if (!review || !confirmed.checked) return;
  commitButton.disabled = true;
  confirmed.disabled = true;
  setStatus("Committing…");
  try {
    const result = await app.callServerTool({
      name: review.commit.tool,
      arguments: review.commit.arguments,
    });
    if (result.isError) {
      setStatus(textResult(result), "error");
      confirmed.disabled = false;
      commitButton.disabled = !confirmed.checked;
      return;
    }
    setStatus(textResult(result), "success");
    commitButton.textContent = "Committed";
    await app.updateModelContext({
      content: [{ type: "text", text: `The user committed inventory plan ${review.plan_id} from the extended review app. ${textResult(result)}` }],
      structuredContent: result.structuredContent,
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "The commit request failed.", "error");
    confirmed.disabled = false;
    commitButton.disabled = !confirmed.checked;
  }
});

app.ontoolresult = (result) => {
  const data = reviewData(result.structuredContent);
  if (data) render(data);
};

await app.connect();
