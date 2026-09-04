"use client";

import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * UX pass 1, slice 4 (A-10): the hand-off from "done writing" to "students
 * are taking it", spelled out where the teacher finishes — until now nothing
 * said a session needs publishing first.
 */
export function NextStepCard({
  status,
  onPublish,
  onStartSession,
}: {
  status: string;
  onPublish: () => void;
  onStartSession: () => void;
}) {
  const published = status === "published";
  return (
    <Card className="border-brand/40 bg-accent/60">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-medium">
            {published ? "Ready for students" : "Finished writing?"}
          </div>
          <div className="text-sm text-muted-foreground">
            {published
              ? "Start a test session and read the code to the class."
              : "Publish to lock the questions, then start a test session."}
          </div>
        </div>
        {published ? (
          <Button type="button" onClick={onStartSession}>
            Start a test session
            <ArrowRight aria-hidden />
          </Button>
        ) : (
          <Button type="button" onClick={onPublish}>
            Publish
            <ArrowRight aria-hidden />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
