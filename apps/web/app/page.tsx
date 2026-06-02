import { redirect } from "next/navigation";

// "/" → the default locale, which renders the configured start page.
export default function Root() {
  redirect("/en");
}
