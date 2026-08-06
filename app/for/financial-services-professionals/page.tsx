import type { Metadata } from "next";
import { RedactifyExperience } from "../../page";
import { audiencePages } from "../../audience-pages";

export const metadata: Metadata = {
  title: "Financial services professionals — Redactify",
  description: audiencePages["financial-services-professionals"].description,
};

export default function FinancialServicesProfessionalsPage() {
  return <RedactifyExperience audienceKey="financial-services-professionals" />;
}
