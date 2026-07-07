#!/usr/bin/env python3
"""
oc-li ↔ engagement engine glue.

Thin adapter that lets the oc-li Node agent reuse the EXISTING sales reply
engine (engagement.on_message_received for CRM/BANT/intent + auto_reply.
generate_reply for the LLM reply via the OC router). It only rewires I/O:
  IN  : one inbound message from the OpenCLI LinkedIn listener (stdin JSON)
  OUT : {"reply": <text|null>, "action": <str>}  (stdout JSON)
It does NOT send — oc-li delivers the reply in-band via its sendfile — and it
does NOT touch Unipile for delivery. Mirrors webhook_receiver.process_message_received.
"""
import sys, json, sqlite3
sys.path.insert(0, '/root')

LEADS_DB = '/root/unipile_webhooks.db'
LEAD_COLS = ['id', 'first_name', 'last_name', 'headline', 'company', 'role',
             'location', 'icp_tier', 'enrichment_notes', 'conversation_summary',
             'conversation_turns', 'chat_id', 'message_variant', 'replied',
             'outreach_status', 'public_profile_url']

def main():
    try:
        inp = json.loads(sys.stdin.read() or '{}')
    except Exception as e:
        print(json.dumps({"reply": None, "action": "bad_input", "error": str(e)})); return

    member_id = (inp.get('member_id') or '').strip()
    chat_id   = (inp.get('chat_id') or inp.get('thread_id') or '').strip()
    text      = inp.get('text') or ''
    if not member_id or not text:
        print(json.dumps({"reply": None, "action": "missing_fields"})); return

    from engagement import on_message_received
    from auto_reply import generate_reply

    # CRM / BANT / intent — same call the Unipile webhook made
    result = on_message_received(chat_id, member_id, text, False)
    action = result.get('action')

    # Look up the lead (member_id == the ACoAA… id oc-li already has)
    db = sqlite3.connect(LEADS_DB)
    row = db.execute(
        "SELECT " + ", ".join(LEAD_COLS) + " FROM leads WHERE member_id=?",
        (member_id,)).fetchone()
    db.close()
    if not row:
        print(json.dumps({"reply": None, "action": "unknown_inbound"})); return
    lead = dict(zip(LEAD_COLS, row))

    # Reply to any ACTIVE conversation action. The old webhook only replied on
    # 'in_conversation', which left interested leads (flag_interested), meeting
    # requests and scheduled follow-ups sitting in silence. For an auto-engagement
    # bot we reply to everything except explicit disinterest / outbound ('none').
    reply = None
    if action and action != 'none':
        try:
            reply = generate_reply(lead, chat_id, text)
        except Exception as e:
            print(json.dumps({"reply": None, "action": action, "error": str(e)[:200]})); return
        # SAFETY: never forward an LLM/infra error string as a message to a lead.
        # If the model backend 503s, generate_reply can hand back the gateway error
        # text — drop it so oc-li sends nothing instead of garbage.
        if reply:
            low = reply.lower()
            if any(b in low for b in ("api call failed", "no available account", "http 503",
                                      "http 502", "http 500", "http 429", "internal server error",
                                      "all llm endpoints failed")):
                reply = None

    print(json.dumps({"reply": reply, "action": action,
                      "lead": f"{lead.get('first_name')} {lead.get('last_name')}"}))

main()
