import type { Metadata } from "next";
import { RedactifyExperience } from "../../page";
import { audiencePages } from "../../audience-pages";

export const metadata: Metadata = {
  title: "Recruiters — Redactify",
  description: audiencePages.recruiters.description,
};

export default function RecruitersPage() {
  return <RedactifyExperience audienceKey="recruiters" />;
}
