#!/usr/bin/env bash
set -euo pipefail
: "${ES_URL:=https://localhost:9200}"
: "${ES_CA_CERT:?Set ES_CA_CERT to the trusted PEM certificate}"
: "${ELASTIC_PASSWORD:?Set ELASTIC_PASSWORD for admin bootstrap only}"
: "${ES_PASSWORD:?Set ES_PASSWORD for companion_svc}"
export ES_PASSWORD
command -v node >/dev/null
request() {
  curl --silent --show-error --fail --cacert "$ES_CA_CERT" \
    --user "elastic:$ELASTIC_PASSWORD" -H 'Content-Type: application/json' "$@"
}
request -X PUT "$ES_URL/_security/role/companion_app" --data-binary @- <<'JSON'
{"cluster":["monitor_inference"],"indices":[{"names":["talks","talks-v*","attendees","attendees-v*","schedules","schedules-v*","entitlements","entitlements-v*","interest_clusters","interest_clusters-v*"],"privileges":["create_index","manage","read","write"],"allow_restricted_indices":false}]}
JSON
# JSON encoding prevents password characters from corrupting the request.
node -e 'process.stdout.write(JSON.stringify({password:process.env.ES_PASSWORD,roles:["companion_app"]}))' |
  request -X PUT "$ES_URL/_security/user/companion_svc" --data-binary @-
license_type=$(request "$ES_URL/_license" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).license.type))')
case "$license_type" in
  trial|platinum|enterprise)
    echo "Inference-capable license already active: $license_type"
    ;;
  *)
    eligible=$(request "$ES_URL/_license/trial_status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s).eligible_to_start_trial)))')
    if [[ "$eligible" != true ]]; then
      echo 'Trial unavailable: ask the license owner to activate an inference-capable license.' >&2
      exit 1
    fi
    request -X POST "$ES_URL/_license/start_trial?acknowledge=true"
    ;;
esac
echo 'Bootstrap complete. Use companion_svc for the app; remove admin credentials from its environment.'
