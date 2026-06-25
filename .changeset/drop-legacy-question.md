---
"@tangle-network/agent-interface": minor
---

BREAKING: remove the deprecated `question` stream event and `submitQuestionAnswer` adapter method. Use the generalized `interaction` event (`kind: "question"`) and `respondToInteraction` introduced in 0.12.0.
