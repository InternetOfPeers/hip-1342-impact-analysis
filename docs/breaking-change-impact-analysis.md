# Breaking Change Impact Analysis

# Executive Summary

Every Hedera Improvement Proposal (HIP) that introduces a **breaking change** — whether it alters consensus rules, modifies API behavior, or changes how existing transactions are processed — carries inherent risk to the live network and its ecosystem. A single under-analyzed change can disrupt production applications, erode developer trust, and generate costly incident-response cycles. Despite this, the current HIP workflow does not mandate a structured impact analysis before activation, leaving the depth and rigor of such analysis to the discretion of individual contributors.

**We propose making a formal Impact Analysis a mandatory, well-defined step for every HIP that introduces a breaking change.** The process is lightweight by design — it adds no bureaucratic overhead for non-breaking HIPs and reuses data sources the team already has access to (mirror node databases, network explorer, GitHub, etc.). In return, it delivers:

- **Risk reduction**. Quantified exposure (affected accounts, contracts, transaction volume) replaces guesswork and gut feeling.
- **Informed scheduling**. Activation timing can be tied to concrete data rather than arbitrary release windows.
- **Proactive communication**. Identified stakeholders can be contacted before the change lands, reducing surprise failures and support load.
- **Public credibility**. A published analysis signals engineering maturity and respect for the ecosystem, strengthening Hedera's position with enterprise adopters.
- **Audit trail**. A recorded analysis provides defensible justification for decisions, useful for post-mortems and governance reviews.
- **Faster consensus**. A shared, evidence-based artifact reduces debate cycles in working groups and council reviews.

The cost of *not* doing this is measured in potential broken integrations, emergency patches, and reputational damage. The cost of doing it is a well-scoped spike of analytical work that pays for itself by de-risking every subsequent step.

**Recommendation:** Adopt the Impact Analysis as a required gate in the HIP lifecycle for any proposal tagged as a breaking change. Creating a dedicated internal QA team would be also ideal, because this ensure the quality and coherence of the activity.

The sections below define the process, deliverables, and responsibilities so the team can begin executing immediately.

# **Breaking Change Impact Analysis**

## Purpose and Scope

This document defines the **Breaking Change Impact Analysis** process — a mandatory step in the lifecycle of any HIP that introduces a breaking change to the Hedera network.

We define a **breaking change** as any modification that:

- Alters consensus rules such that previously valid transactions become invalid, or previously invalid transactions become valid.
- Changes the behavior, output, or error codes of existing APIs, SDKs, or system contracts in a way that may affect existing callers.
- Modifies state structures, record formats, or event schemas consumed by downstream systems like block nodes, mirror nodes, explorers, etc.
- Removes, renames, or redefines existing functionality.

The goal is to ensure that a data-driven understanding of the real-world impact of every such change is in place **before** Hiero Technical Steering Committee (TSC) approval or, in the worst-case scenario, Hedera TechCom acceptance.

## When to Perform the Analysis

The impact analysis **MUST** be completed:

- **After** the HIP has been technically reviewed by the working group and the community (`Last call`), such as all the technical details are in place to determine the impacts on current state of the network and the ecosystem.
- **Before** the HIP is considered `Ready for review` by the TSC

The analysis MAY be started earlier (e.g., during `Review` phase) if the author or working group wants early signal and no major feedbacks/pushbacks are expected by the community. Early analysis can also strengthen the HIP itself by providing concrete data in the **Backwards Compatibility** section, although not mandatory.

## Process Steps

### Classify the Breaking Change

<aside>
📄

**Deliverable**: A concise *Change Classification Card* (a few paragraphs or a table) appended to the analysis report.

</aside>

**Tasks**

1. **Identify the change type**. Consensus rule change, API behavior change, state/schema change, feature removal, etc.
2. **Define the affected surface**. Which system contracts, APIs, transaction types, record fields, or SDK methods are affected?
3. **Describe the behavioral delta**. What was the old behavior? What is the new behavior? Under what conditions does the difference manifest?

### Query Historical Network Data

<aside>
📄

**Deliverable:** *Network Data Report* — a summary table with metrics and a link/appendix with the raw queries.

</aside>

Using Hashgraph Mirror Node databases (mainnet and, optionally, testnet), identify transactions and accounts that would be affected by the change.

**Tasks**

1. **Design queries**. Write SQL queries that isolate the transactions matching the affected surface. For example, for the HIP-1342 "Ignore Trailing Calldata for System Contract", query all Ethereum transactions calling system contracts that failed with a `CONTRACT_REVERT_EXECUTED` status and whose calldata length exceeds the expected ABI-encoded length.
2. **Run on mainnet**. Execute queries against mainnet mirror node data. Record result counts, unique payer accounts, unique contract targets, time range, and volume trends.
3. **Sample and inspect**. For non-trivial result sets, sample 10-20 transactions and manually inspect calldata, caller, and context to validate that the query is capturing genuine impact cases (not false positives).
4. **Document queries**. Preserve the exact queries used so they can be re-run or audited.
5. **Run on testnet**. Repeat steps 1-4 on testnet. Testnet data can reveal developer experimentation patterns.

Example metrics table:

| Metric | Mainnet | Testnet |
| --- | --- | --- |
| Total affected transactions | — | — |
| Unique payer accounts | — | — |
| Unique target contracts | — | — |
| Trend (increasing/stable/decreasing) | — | — |
| Average daily occurrence | — | — |

### Identify Affected Stakeholders

<aside>
📄

**Deliverable:** *Stakeholder Map* — a table listing affected entities, contact status, and estimated impact direction.

</aside>

**Tasks**

1. **Map accounts to known entities**. Cross-reference payer and contract accounts against known ecosystem participants (exchanges, bridges, dApps, infrastructure providers). Use internal contact databases, public deployment registries, and explorer labels.
2. **Categorize stakeholders**. Label each as: **Known & contactable**, **Known but no direct contact**, **Unknown**.
3. **Get severity feedback from per stakeholder**. For each, estimate how the change affects them: positive (previously-broken flow now works), neutral, or negative (relied on old behavior).

### Evaluate Impact Severity

<aside>
📄

**Deliverable:** *Impact Severity Assessment* — a short narrative with a rated severity and supporting rationale.

</aside>

**Tasks**

1. **Quantify exposure**. How many projects/users are affected? What is the financial volume (if token transfers are involved)?
2. **Assess reversibility**. If the change causes issues, can it be rolled back without a hard fork? What is the rollback cost?
3. **Identify edge cases**. Are there scenarios where the change could cause subtle, hard-to-detect issues (e.g., silent behavior differences rather than clear failures)?
4. **Rate overall severity**. Assign a severity rating: **Low** (minimal real-world impact, few or no affected users), **Medium** (moderate number of users, manageable with communication), **High** (broad impact, financial risk, or critical infrastructure affected).

### Compile and Review the Analysis Report

<aside>
📄

**Deliverable:** *Final Impact Analysis Report* linked from the HIP.

</aside>

1. **Assemble the report**. Combine all deliverables into a single document (Markdown if possible).
2. **Attach to the HIP**. Link the analysis report from the HIP's Backwards Compatibility section. Upload the analysis and the supporting files to the GitHub repo.
3. **Present to leadership**. Provide a brief executive summary (severity rating, key numbers, recommended timing) for decision-makers.

## Report Template

Below is a minimal template that can be used for each analysis.

```markdown
# Impact Analysis — HIP-XXXX: [Title]

## Change Classification
- **Type:** [Consensus rule / API behavior / Schema / Feature removal]
- **Affected Surface:** [System contracts / APIs / Transaction types / etc.]
- **Behavioral Delta:** [Old behavior] → [New behavior]

## Network Data Summary
| Metric                   | Mainnet | Testnet |
|--------------------------|---------|---------|
| Total affected txns      |         |         |
| Unique payer accounts    |         |         |
| Unique target contracts  |         |         |
| Trend                    |         |         |
| Daily occurrence         |         |         |

### Queries Used
[Link or inline SQL/REST queries]

### Sample Transactions
[List 5-10 representative transactions with brief notes]

## Stakeholder Map
| Entity         | Account(s)  | Contact Status        | Impact Direction |
|----------------|-------------|-----------------------|------------------|
| [Name/Unknown] | 0.0.XXXX    | Known & contactable   | Positive         |
| ...            | ...         | ...                   | ...              |

## Impact Severity
- **Rating:** [Low / Medium / High]
- **Rationale:** [2-3 sentences]

## Communication and Mitigation Plan
| Action                  | Owner   | Deadline  | Status  |
|-------------------------|---------|-----------|---------|
| Direct outreach to X    | @name   | YYYY-MM-DD| Planned |
| Release notes draft     | @name   | YYYY-MM-DD| Planned |
| Testnet activation      | @name   | YYYY-MM-DD| Planned |
| Mainnet activation      | @name   | YYYY-MM-DD| Planned |
| Post-activation monitor | @name   | YYYY-MM-DD| Planned |

## Reviewer Sign-off
- [ ] Analysis reviewed by: @reviewer (date)
```

## Roles and Responsibilities

Considering the nature of the activity and the tools currently available, the best team for an impact analysis is a mix of Developers (for defining the details of what we need to search and analyze, interpret the findings, etc.), DevOps (to actually implement and execute the queries, the communication actions, etc.), and HIP authors (for summarizing the data and presenting it to the TSC).

**Creating a dedicated QA team would be ideal** and, while not busy with impact analysis, that team would also prove useful for integration tests, performance tests, etc.

In case we cannot create a dedicated team, we need to rent time from different teams, and in particular:

- HIP Author / Working Group
    - Specify the changes and interact with the Hashgraph SMEs to define a first scope of the analysis
- Subject Matter Experts (mostly Engineering Teams, possibly DevOps, DevRel, DAs)
    - Define the requirements, the results needed
- DevOps
    - Help refining and executing queries for data gathering
- DevRel / Communications
    - Execute public announcements, documentation updates, and developer outreach based on the plan
- IT support
    - Provide tools to automate the execution of specific steps (ie. contacting on-chain accounts, sending emails, etc.)

## Communication Plan

<aside>
📄

**Deliverable:** *Communication Plan* — actionable items with owners and deadlines.

</aside>

Although not part of the Impact Analysis, in case the HIP is approved by TSC, a communication plan is due to be presented **before** the Hedera TechCom’s approval. This helps the committee to prove to the Governing Council that all the possible actions have been taken into consideration to preserve the applications functionalities and safeguard the network value.

The execution of the plan MUST be executed **before** the activation of the HIP on the testnet.

- **Direct outreach**. For known & contactable stakeholders: draft communication (email, Slack, GitHub issue) explaining the change, timeline, and any action required on their side.
- **On-network notification**. For unknown actors: consider on-network contact methods (e.g., zero-value transfer with memo to affected accounts. If funds are at risk because of the change, we consider private messaging solutions such as HIP-1334 “Private Message Box Standard for Hiero Accounts”).
- **Public announcement**. Draft release notes entry, blog post, or developer newsletter segment describing the change and its implications.
- **Documentation updates**. Identify docs, tutorials, and SDK change logs that need updating.
- **Activation timing**. Recommend activation timing based on severity: immediate (next release), delayed (give N weeks notice), or staged (testnet first for M weeks, then mainnet).

## Illustrative Example: HIP-1342 “Ignore Trailing Calldata for System Contract”

To make this process concrete, here is how it would apply to the example HIP-1342 "Ignore Trailing Calldata for System Contract".

**Classification**

- Consensus rule change
- Affects all system contracts (HTS, HAS, HSS) and redirect-for-token paths
- Behavioral delta: transactions with trailing calldata that previously reverted will now succeed.

**Network Data**

- <QUERIES>
- Results of querying the mainnet/testnet mirror node for all `EthereumTransaction` records targeting system contract addresses where `result = CONTRACT_REVERT_EXECUTED` and `input` length exceeds the expected ABI-encoded length for the matched function selector. Count transactions, unique payers, unique targets, and trend over time.

**Stakeholder Map**

- Cross-reference payer accounts with known entities (SaucerSwap, etc). Flag any unknown accounts for on-network outreach.

**Severity**

- Likely **Low-to-Medium** — the change *fixes* a compatibility issue, so impact direction is overwhelmingly positive. Negative impact (someone relying on the revert) is theoretically possible, and it should not be under estimated.

**Communication Plan**

- Direct outreach to known affected stakeholders (SaucerSwap, etc.)
- On-chain communications to affected unknown accounts
- Release notes entry
- Developer blog post

## FAQ

**Q: Does this apply to every HIP?**
A: No. Only HIPs that introduce a breaking change. The vast majority of HIPs are additive and skip this step entirely.

**Q: How long should the analysis take?**
A: For most breaking changes, 3–5 working days of focused effort. Complex changes affecting many transaction types may take longer, but the more we do this the more tools we will have to reduce the effort for each HIP. The analysis can (and should) be started as early as possible, even during the `Review` phase if technical details are not expected to change.

**Q: What if the analysis reveals zero affected transactions?**
A: That's still a valid and valuable finding. Document it — a clean result de-risks activation and can accelerate the timeline. The analysis still serves as due diligence and an audit trail.

**Q: Can the analysis block a HIP indefinitely?**
A: No. The analysis informs decisions; it does not have veto power over a HIP's acceptance. Even a high-severity finding simply means the communication and mitigation plan must be proportionally robust before activation proceeds.

**Q: Who pays for the engineering time?**
A: Hashgraph. Part of the analysis is performed by the HIP author or working group as part of the standard HIP development effort, but a dedicated QA team or time from the engineering teams is needed. The total cost would be probably a fraction of the engineering time that will be invested in designing and implementing the change itself, and with automation and improving the analysis tools dedicated to this kind of activities, we can reduce the costs with time. With the growth of the ecosystem, we can think about methods to share or externalize these activities to other companies.
