import type { Metadata } from "next";
import { RedactifyExperience } from "../../page";
import { audiencePages } from "../../audience-pages";

export const metadata: Metadata = {
  title: "ChatGPT Users — helpRedact.com",
  description: audiencePages["chatgpt-users"].description,
};

export default function ChatGptUsersPage() {
  return <RedactifyExperience audienceKey="chatgpt-users" />;
}
