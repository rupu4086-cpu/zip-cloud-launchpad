import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "TechnoTrade Academy — Learn Trading" },
      { name: "description", content: "Learn trading with TechnoTrade Academy courses." },
      { property: "og:title", content: "TechnoTrade Academy — Learn Trading" },
      { property: "og:description", content: "Learn trading with TechnoTrade Academy courses." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  useEffect(() => {
    window.location.replace("/technotrade.html");
  }, []);
  return null;
}
