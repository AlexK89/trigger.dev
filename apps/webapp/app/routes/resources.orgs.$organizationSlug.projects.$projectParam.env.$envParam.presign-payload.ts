import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { nanoid } from "nanoid";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { generatePresignedUrl } from "~/v3/objectStore.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const filename = `upload_${nanoid()}/payload.json`;

  const signed = await generatePresignedUrl(
    environment.project.externalRef,
    environment.slug,
    filename,
    "PUT",
    { expiresIn: 900 }
  );

  if (!signed.success) {
    const isNotConfigured = signed.error.includes("not configured");
    return json(
      { error: `Failed to generate presigned URL: ${signed.error}` },
      { status: isNotConfigured ? 501 : 500 }
    );
  }

  if (!signed.storagePath) {
    return json({ error: "Failed to resolve storage path" }, { status: 500 });
  }

  return json({ presignedUrl: signed.url, storagePath: signed.storagePath });
}
