# Confirming an email actually went out

**The Gmail Sent folder is not the answer.** Every automated email goes through
Resend, which delivers from `support@lilacomposter.com` without ever touching
the mailbox. Nothing we send automatically will appear in Sent, so an empty
Sent folder is expected and proves nothing. (Gmail DWD would leave a Sent
record, but no send path uses it.)

There are three ways to check, in order of directness.

## 1. The order itself

Fulfillment → Shipped → open the order. The **Shipment email** card shows the
delivered-to address, the send time, the status, the Resend message id, and the
exact body behind "Read the email that was sent".

This is the strongest evidence: the body shown is the text Resend was handed,
not a re-render of the template, so it reflects any per-send edit.

Sends before **24 Sep 2026** predate the audit row. Those say the copy was not
kept and fall back to the queue's own timestamp — that is missing evidence, not
a missing email.

## 2. Reina's inbox

Every customer-facing send is blind-copied to `reina@virgohome.io`. BCC, not
CC: the customer never sees an internal address and cannot reply-all into it.

The address is `EMAIL_ARCHIVE_BCC` on the edge functions. Set it to change who
receives the copy; set it empty to switch the copies off. No deploy needed.

Internal mail is skipped — operator digests, the cancellation alert, and the
return review already go to the team, and `archiveBcc()` drops the copy when
every recipient is on `@virgohome.io` or when the archive address is already a
recipient.

## 3. The audit table

Templates → pick a template → its last ten sends, with rendered subject and
body. `email_messages` holds recipient, status, Resend id, and any error.

## What is covered

| Function | Audit row | BCC to archive |
|---|---|---|
| `send-fulfillment-email` (shipment confirmation) | yes | yes |
| `send-template-email` (returns, refunds, cancellations UI) | yes | yes |
| `send-refund-reminders` | yes | yes |
| `send-return-followups` | yes | yes |
| `send-address-confirmations` | **no** | yes |
| `send-return-emails` (customer copy) | **no** | yes |
| `send-cancellation-emails` | no | n/a — internal alert to Reina |
| `send-eztrans-booking` | no | no — carrier booking, not customer mail |
| `send-assignment-digests` | yes | n/a — internal |
| `freight-rate-report` | yes | n/a — internal |

Address confirmations and return emails still write no audit row, so for those
the BCC is the only record. Giving them one is the obvious next step.

## Reading it straight from the database

```sh
# every logged send for one order
curl -s -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY" \
  "$URL/rest/v1/email_messages?variables->>order_ref=eq.%231184\
&select=subject,recipient_email,status,error,resend_id,sent_at"
```

`email_messages` has no order column; the link runs through the rendered
variables, which carry the `order_ref` the mail was built from.

## If a send really did fail

The audit row is written *before* Resend is called and updated after, so a row
stuck at `queued` means the function died mid-send, and `failed` carries
Resend's own error in `error`. Either way the queue step will not have advanced.
