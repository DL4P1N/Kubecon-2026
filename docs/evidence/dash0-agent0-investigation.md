# Dash0 MCP / Agent0 investigation evidence

This is the captured **before** investigation, recorded 2026-11-09 at 19:55:19Z. The bundle identifies it as actual Dash0 MCP and Agent0 responses and says no controlled fault was introduced.

- [Raw evidence bundle](../demo/dash0-agent0-investigation.json)
- [Readable rendering of the actual output excerpt](../demo/dash0-agent0-output.png)
- [Agent0 thread deep link](https://app.dash0.com/goto/agent0?thread_id=403666a6-f969-4ac5-b8d2-816a99d1f601&dataset=default&org=7f8e68b8-3711-4202-a072-39afccb6b736&utm_source=mcp&utm_content=waitForTask&utm_medium=deeplink)
- [Trace deep link (browser/client span)](https://app.dash0.com/goto/traces/explorer?org=7f8e68b8-3711-4202-a072-39afccb6b736&dataset=default&from=now-30m&to=now&trace_id=8778b96f68d1a459a57249049364be06&span_id=0eceeb3fad9be3a6&utm_source=mcp&utm_content=getTraceDetails&utm_medium=deeplink)
- [Trace deep link (internal request span)](https://app.dash0.com/goto/traces/explorer?org=7f8e68b8-3711-4202-a072-39afccb6b736&dataset=default&from=now-1h&to=now&trace_id=8778b96f68d1a459a57249049364be06&span_id=3481cc0b4bcc3655&utm_source=mcp&utm_content=getTraceDetails&utm_medium=deeplink)

## Confirmed observations

The actual Agent0 response reports one observed companion-api HTTP 400 on `/api/search` at 19:47:11Z in trace `8778b96f68d1a459a57249049364be06`. The browser/client span is `0eceeb3fad9be3a6`; the API server span is `64b3fdeb55e52522`; the internal request span is `3481cc0b4bcc3655`. Agent0 reports two INFO logs and no WARN/ERROR logs for the request. It says it found no registration-page trace and cannot link this request to the displayed “topic discovery failed” message.

**Analyst correction, directly confirmed by the raw request-span attributes:** Agent0 says the query value is not exported. The directly inspected internal span contains `url.path=/api/search?q=&mode=keyword` (HTTP status 400). Thus the query string is present in `url.path`; Agent0's contrary statement is an inference/error, not a direct observation. The presence of this path attribute is a privacy allowlist escape. This confirms the escaped URL data, not that the empty query caused the 400.

## Agent0 inference and smallest action

Agent0 guesses that an empty `q` may trigger validation, but explicitly says telemetry does not confirm the validation cause. Its smallest suggested action is to inspect the `/api/search` handler's validation for empty `q` and whether companion-web avoids issuing an empty-query request; it also cautions that the registration-page relationship is unverified. Do not treat the guess as a confirmed cause.

The MCP initial response includes a thread URL but states that API-token-authenticated conversations are not attributed to a Dash0 user and are not accessible in the Dash0 platform. The deep link is reproduced as returned; this evidence does not imply that the thread can be opened in the product UI.

## Remediation and observed after-state

The operator removed `url.path` from trace, log and metric-point allowlists,
retained bounded `http.route`, and rolled out the corrected collector. The
[actual after export](../demo/dash0-after-spans.json), captured at 20:02:26Z,
contains API search server spans returning 200 and internal request spans with
`http.route=/api/search` and an empty `url.path` column. Example traces:
`a0d366267756331cc02c1104fb472e29` and
`2101fa365943db43ef89ae9ac2900407`. These are actual subsequent browser searches,
not injected faults. This verifies the sampled exported attribute correction;
it does not prove every privacy path or an end-to-end Elasticsearch child span.

The before request was an empty-query 400; the later successful searches used
valid input. Their 200 responses do not prove the registration bug was fixed.
That separate contract fix is [PR28](https://github.com/DL4P1N/Kubecon-2026/pull/28).
The durable collector and manual route-attribute migration is checkpoint commit
`fe34415`, completed by board task #40's PR. At after-capture time API/web still
ran `753dd61`; the collector correction was live, while the manual code migration
had not been deployed. Tests retain code/docs/collector synchronization checks
and verify raw `url.path` is dropped both at span creation and later mutation.
The separate raw log-path remediation is
[PR52](https://github.com/DL4P1N/Kubecon-2026/pull/52).
