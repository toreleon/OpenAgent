"use client";

/** Renders an image URL or data URL on a contained preview canvas. */
export function ImageArtifact({ content }: { content: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center overflow-auto bg-[#0d0d0d] p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={content.trim()}
        alt="Artifact image"
        referrerPolicy="no-referrer"
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  );
}

export default ImageArtifact;
