when workin in a git repository, unless otherwise stated:
- commit after each requested change
- commit only changes you've done

secret handling:
- do not read `.env`, `.env.*`, or other local secret files unless the user explicitly asks for it
- do not print, echo, cat, grep, or otherwise reveal secrets or secret-bearing files in chat or command output
- when a task needs secret-backed config, infer variable names from code/docs and have the user provide or set values out of band
- if a command must touch a secret file, avoid outputting its contents and avoid relaying secret values back to the user
