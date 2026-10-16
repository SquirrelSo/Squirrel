# Visibility Checklist

For any list endpoint or permission change, test each row from four viewers, under two conditions (8 cells total):

| Viewer | Social UP | Social DOWN |
|---|---|---|
| Whoever created it | | |
| The person or crew it targets | | |
| Someone unrelated | | |
| Someone who blocked, or is blocked by, the creator | | |

## Why we test this
A test written alongside a fix shares its reasoning. Checking who must NOT see a row, without checking who MUST, is how all three of these bugs passed:

- The crew claim 500: territories.crew_id still had a foreign key to campus's retired crews table, so anyone in a Social crew got a 500 when claiming a zone. The tests ran with Social off, so nobody was ever in a crew.
- The widened outage list: when Social was unreachable, the challenge list returned every crew-targeted row to everyone, including the message written for the target crew. Caught by the unrelated viewer, Social down.
- The missing outgoing rows: the fix for that filtered outgoing challenges by membership too, so a creator who challenged a crew they were not in never saw their own challenge. Caught by the creator viewer, Social up.
