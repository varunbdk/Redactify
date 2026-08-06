import type { Metadata } from "next";
import { RedactifyExperience } from "../../page";
import { audiencePages } from "../../audience-pages";

export const metadata: Metadata = {
  title: "Legal professionals — helpRedact.com",
  description: audiencePages["legal-professionals"].description,
};

export default function LegalProfessionalsPage() {
  return <RedactifyExperience audienceKey="legal-professionals" />;
}
