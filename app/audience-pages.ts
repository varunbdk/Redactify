export const audiencePages = {
  "chatgpt-users": {
    name: "ChatGPT Users",
    eyebrow: "PREPARE PDFs FOR CHATGPT",
    title: "Redact private details before sharing a PDF with ChatGPT",
    description: "Prepare a safer copy for summarising, analysing, or discussing with ChatGPT—without sending the original document to helpredact.com.",
    benefits: [
      "Find names, addresses, account details, IDs, and other sensitive text quickly.",
      "Review, resize, remove, or add every redaction before anything is applied.",
      "Download a permanently redacted copy that passes a local safety check.",
    ],
  },
  "claude-users": {
    name: "Claude Users",
    eyebrow: "PREPARE PDFs FOR CLAUDE",
    title: "Remove sensitive information before sharing a PDF with Claude",
    description: "Create a cleaner copy for document analysis, drafting, or research with Claude while keeping the original PDF on your device.",
    benefits: [
      "Automatically surface common personal, financial, identity, and network details.",
      "Stay in control with an easy visual review and manual redaction tools.",
      "Export only after approved regions and sensitive values pass verification.",
    ],
  },
  "legal-professionals": {
    name: "Legal professionals",
    eyebrow: "PRIVATE REDACTION FOR LEGAL WORK",
    title: "Prepare legal documents for safer review and sharing",
    description: "Quickly review contracts, correspondence, statements, and case documents for sensitive client information before sharing a redacted copy.",
    benefits: [
      "Identify names, addresses, account details, and reference numbers in text-based PDFs.",
      "Adjust every suggested box or draw precise manual redactions directly on the page.",
      "Keep documents local and receive a verified, permanently redacted export.",
    ],
  },
  "financial-services-professionals": {
    name: "Financial services professionals",
    eyebrow: "PRIVATE REDACTION FOR FINANCIAL DOCUMENTS",
    title: "Redact financial documents quickly, with every decision visible",
    description: "Review statements and client documents for account holders, account numbers, IBANs, addresses, and reference IDs without uploading the source file to helpredact.com.",
    benefits: [
      "Use statement-aware detection for labelled financial and customer information.",
      "Group fragmented details and multi-line addresses into clearer suggestions.",
      "Verify approved values are absent from the exported PDF text layer before download.",
    ],
  },
  recruiters: {
    name: "Recruiters",
    eyebrow: "PRIVATE REDACTION FOR RECRUITMENT",
    title: "Share candidate documents with less personal information",
    description: "Prepare CVs, applications, and candidate documents for internal review or AI-assisted work by removing details that are not needed.",
    benefits: [
      "Find names, email addresses, phone numbers, postal addresses, and identifiers.",
      "Review every suggestion in a simple visual workspace before redacting it.",
      "Download a safer copy while the original stays in your browser session.",
    ],
  },
} as const;

export type AudienceKey = keyof typeof audiencePages;
