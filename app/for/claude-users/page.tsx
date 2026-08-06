import type { Metadata } from "next";
import { RedactifyExperience } from "../../page";
import { audiencePages } from "../../audience-pages";

export const metadata: Metadata = {
  title: "Claude Users — Redactify",
  description: audiencePages["claude-users"].description,
};

export default function ClaudeUsersPage() {
  return <RedactifyExperience audienceKey="claude-users" />;
}
