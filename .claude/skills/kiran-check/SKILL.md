---
name: kiran-check
description: Kiran's combined way to run a double code review and put it into language or frame he can understand.
---


Look at the pull request specified, and then spin up 2 opus subagents. One subagent will run Matt Popcock's code review skill, and the other subagent will run the default anthropic code review skill. Wait until both have returned their findings, then deduplicate any findings. Next, prepare to put them as a comment in the pull request on GitHub. Instructions for the GH PR comment - For any findings, make sure that you provide a explanation that an 18-year-old in a non-coding background could understand, together with solutions and a recommendation. Ensure that each issue is numbered and that there is a checkbox next to each issue so that I can easily reference them in my discussions with you and check them off as we go through fixing any issues.
