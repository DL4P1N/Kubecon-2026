/**
 * The judged query set shared by the eval harnesses. Kept in its own module so
 * that importing it has no side effects: `scripts/search-eval.ts` runs `main()`
 * at module top level, and the held-out harness imports the set without wanting
 * the full eval to start.
 *
 * Queries are paraphrased attendee questions that avoid the catalog's own
 * vocabulary. Judgments were hand-picked by reading titles and abstracts in
 * data/talks.json; the `why` line records the reason for each.
 */
export interface Judged {
  q: string;
  relevant: string[];
  why: string;
}

export const EVAL_SET: Judged[] = [
  {
    q: "make sure nobody can tamper with the software I ship to customers",
    relevant: ["kcna26-1370530", "kcna26-1289646", "kcna26-1247300"],
    why: "supply-chain security: self-hosted signed build pipeline; in-toto attestations/provenance; Sigstore attestation-driven admission at AT&T",
  },
  {
    q: "my pager keeps going off at night and I want a computer to help figure out why",
    relevant: ["kcna26-1244963", "kcna26-1250770", "kcna26-1238718"],
    why: "AI-assisted alert triage / incident response: Verkada's alert-triage agent; AI incident response context; HolmesGPT SRE agent",
  },
  {
    q: "spend less money on the machines my containers run on",
    relevant: ["kcna26-1289666", "kcna26-1250015", "kcna26-1250350"],
    why: "Kubernetes cost: OpenCost; per-instance idle cost allocation at Nubank; maximizing cluster allocation of on-prem hardware",
  },
  {
    q: "who is allowed to do what inside my cluster",
    relevant: ["kcna26-1248120", "kcna26-1289677", "kcna26-1289713"],
    why: "Kubernetes authorization: RBAC as a platform capability; conditional authorization in the API server; OPA policy engine",
  },
  {
    q: "let people ask questions about our internal documents without sending them to a third party",
    relevant: ["kcna26-1250975", "kcna26-1250985"],
    why: "self-hosted RAG over documents (Docling + OpenSearch tutorial); local open-weight AI with private datasets",
  },
  {
    q: "my pods take ages to start because downloading the container takes forever",
    relevant: ["kcna26-1250728"],
    why: "pod startup latency dominated by image pull (LinkedIn case study)",
  },
  {
    q: "keep passwords and API keys out of my config files",
    relevant: ["kcna26-1250972", "kcna26-1247134"],
    why: "secrets management: rotation-first identity instead of secrets in YAML; where Kubernetes Secrets break and safer patterns",
  },
  {
    q: "automatically add more copies of my service when traffic spikes",
    relevant: ["kcna26-1249409", "kcna26-1247103", "kcna26-1246812"],
    why: "autoscaling: KEDA production patterns; KEDA at Stripe; explainable agentic autoscaler beyond HPA",
  },
  {
    q: "release a new version to a small slice of users first so a bad deploy does not break everything",
    relevant: ["kcna26-1247840", "kcna26-1250076"],
    why: "canary / progressive rollout: LinkedIn K8s-native canary pipeline; experimentation and flags for risky rollouts",
  },
  {
    q: "split one expensive graphics card between several jobs",
    relevant: ["kcna26-1243199", "kcna26-1241974", "kcna26-1250789"],
    why: "GPU sharing: hardware-level sharing with DRA; memory-safe GPU time-slicing; sharing GPUs across clusters at Snapchat",
  },
  {
    q: "run code written by an AI model without it harming the rest of my system",
    relevant: ["kcna26-1247804", "kcna26-1247753"],
    why: "sandboxing untrusted LLM-generated code: Agent Sandbox tutorial; lessons sandboxing agents with kagent",
  },
  {
    q: "get my stateful apps back after someone deletes the cluster by accident",
    relevant: ["kcna26-1289913", "kcna26-1289726"],
    why: "backup and restore: Velero backups/snapshots; Kubernetes Data Protection WG",
  },
];
