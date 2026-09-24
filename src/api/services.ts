/**
 * Runtime & business-service operations over adt-ls's custom LSP segments: run an
 * executable ABAP object (`adtLs/run`) and inspect/publish a service binding
 * (`adtLs/businessservice/srvb`). Each resolves the object to its repotree AFF URI.
 *
 * Service *info* (OData URL + entity sets) goes through the backend MCP tools
 * `abap_business_services-{fetch_services,fetch_service_information}` — the headless path
 * the editor-only LSP `getServiceEntitySet`/`getPreviewURL` calls do NOT expose (they
 * "Internal error" headless). Verified live (V2 + V4) against a4h.
 *
 * `publishServiceBinding` is a mutation; the library does NOT gate it (consumer policy —
 * ADR-0012).
 */
import { parseFederated } from '../channels/federated.js';
import type { LspClient } from '../driver.js';
import type { Lifecycle, ObjectRef } from './lifecycle.js';
import { readFile } from './repository.js';

export interface ServicesDeps {
  lsp: LspClient;
  /** Reused for name → repotree AFF URI (carries the destination). */
  lifecycle: Pick<Lifecycle, 'resolveAffUri'>;
  /** adt-ls MCP tool invoker (for the business-services tools). */
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** The connected destination id, or undefined. */
  destination: () => string | undefined;
}

/** The OData services a binding exposes (from `fetch_services`). */
export interface ServiceBindingServices {
  bindingType?: string;
  odataVersion?: string;
  odataInfoUri?: Array<{ href: string }>;
  /** The binding's publish state. Sent for OData V4 only (verified live on adt-ls 1.1.2). */
  isPublished?: boolean;
  services: Array<{
    name: string;
    content: Array<{ serviceDefinition: string; serviceVersion: string }>;
    isPublished?: boolean;
  }>;
}
/** Live OData service info (from `fetch_service_information`). */
export interface ServiceInfo {
  serviceUrl: string;
  entitySets: Array<{ name: string; navigations: string[] }>;
}

/** Runtime + business-service surface (the `services` namespace). */
export interface Services {
  /** Run an executable object (classrun / program) and return its console output. */
  runApplication(ref: ObjectRef): Promise<{ output: string }>;
  /** Read a service binding's details (binding type, OData version, service list). */
  serviceBindingDetails(ref: ObjectRef): Promise<unknown>;
  /** Publish (or unpublish) a service binding — mutating. `service` picks the service
   * definition an OData V2 binding toggles (default: its first). */
  publishServiceBinding(ref: ObjectRef, opts?: { service?: string }): Promise<unknown>;
  /** List the OData services a binding exposes (type, version, definitions, and the publish
   * state, which the backend reports for OData V4 only). */
  listServices(ref: ObjectRef): Promise<ServiceBindingServices>;
  /** Live OData service info — the **service URL + entity sets** — for a binding's service
   * (chains fetch_services → fetch_service_information). For an unpublished binding this
   * throws asking you to publish first. `service` picks a specific service (default: first). */
  getServiceInfo(ref: ObjectRef, opts?: { service?: string }): Promise<ServiceInfo>;
}

export function createServices(deps: ServicesDeps): Services {
  const { lsp, lifecycle, callTool } = deps;
  const dest = (): string => {
    const d = deps.destination();
    if (!d) throw new Error('No ABAP destination is connected.');
    return d;
  };

  // The srvb segment loads the binding from the SFS; on an object not yet touched this
  // session the SFS hasn't materialized it, and the call fails with "Unsupported Object
  // Type". readFile populates the SFS first. Verified live on a4h.
  async function resolveAndLoad(ref: ObjectRef): Promise<string> {
    const lsUri = await lifecycle.resolveAffUri(ref);
    await readFile(lsp, lsUri).catch(() => {}); // best-effort SFS warm-up
    return lsUri;
  }

  // fetch_services sends no `isPublished` for an OData V2 binding (verified live on adt-ls
  // 1.1.2); the binding details' `objectData.published` carries it for every OData version.
  async function publishedFromDetails(ref: ObjectRef): Promise<boolean | undefined> {
    const lsUri = await resolveAndLoad(ref);
    const details = await lsp.sendRequest<{
      objectData?: { published?: boolean };
      srvbObjectData?: { published?: boolean };
    } | null>('adtLs/businessservice/srvb/getServiceBindingDetails', { lsUri });
    return (details?.objectData ?? details?.srvbObjectData)?.published;
  }

  async function fetchServices(ref: ObjectRef): Promise<ServiceBindingServices> {
    const res = parseFederated(
      await callTool('abap_business_services-fetch_services', { destination: dest(), serviceBindingName: ref.name }),
    );
    if (!res.ok) throw new Error(`fetch_services failed for ${ref.name}: ${res.text}`);
    return (res.data ?? { services: [] }) as ServiceBindingServices;
  }

  return {
    /**
     * Run an executable ABAP object — a class implementing `if_oo_adt_classrun` (the "ABAP
     * Application (Console)" run target) or an executable program — and return its console
     * output. The object must expose the classrun/programrun discovery relation.
     */
    async runApplication(ref: ObjectRef): Promise<{ output: string }> {
      const uri = await lifecycle.resolveAffUri(ref);
      // Single-string param (matches adtLs/destinations/ensureLoggedOn convention).
      const output = await lsp.sendRequest<string>('adtLs/run/runApplication', uri);
      return { output: output ?? '' };
    },

    /** Read a service binding's details (type, OData version, service list, object data). */
    async serviceBindingDetails(ref: ObjectRef): Promise<unknown> {
      const lsUri = await resolveAndLoad(ref);
      return lsp.sendRequest('adtLs/businessservice/srvb/getServiceBindingDetails', { lsUri });
    },

    /**
     * Publish (or unpublish) a service binding — adt-ls toggles based on the binding's
     * current published state. Mutating. Returns `{isExecuted, isPublishSuccess,
     * statusMessage}`.
     *
     * The action takes the request the VS Code extension builds from the binding details:
     * `{lsUri, serviceName, serviceVersion, bindingType, odataVersion, serviceBindingName}`.
     * Without `odataVersion` adt-ls throws a NullPointerException; for OData V2 it toggles
     * the service content whose service definition equals `serviceName`, and answers
     * "Missing or invalid inputs for publish action" when none does (both verified live on
     * 1.1.2).
     */
    async publishServiceBinding(ref: ObjectRef, opts: { service?: string } = {}): Promise<unknown> {
      const lsUri = await resolveAndLoad(ref);
      const details = await lsp.sendRequest<{
        odataversion?: string;
        serviceType?: string;
        serviceBindingName?: string;
        services?: string[];
      } | null>('adtLs/businessservice/srvb/getServiceBindingDetails', { lsUri });
      const odataVersion = details?.odataversion;
      if (!odataVersion) {
        throw new Error(`Could not read the OData version of service binding ${ref.name}; adt-ls needs it to publish.`);
      }
      const services = details?.services ?? [];
      if (services.length === 0) {
        throw new Error(`No OData service found in binding ${ref.name}.`);
      }
      if (opts.service && !services.includes(opts.service)) {
        throw new Error(
          `Service binding ${ref.name} has no service definition ${opts.service} (has: ${services.join(', ') || 'none'}).`,
        );
      }
      return lsp.sendRequest('adtLs/businessservice/srvb/publishandUnpublishAction', {
        lsUri,
        serviceName: opts.service ?? services[0] ?? '',
        serviceVersion: '',
        bindingType: details?.serviceType ?? '',
        odataVersion,
        serviceBindingName: details?.serviceBindingName ?? ref.name,
      });
    },

    /** List the OData services a binding exposes (`abap_business_services-fetch_services`):
     * `{bindingType, odataVersion, odataInfoUri, isPublished? (V4 only), services:[{name,
     * content:[{serviceDefinition, serviceVersion}]}]}`. */
    listServices(ref: ObjectRef): Promise<ServiceBindingServices> {
      return fetchServices(ref);
    },

    /** OData service URL + entity sets for a binding's service. Chains fetch_services →
     * fetch_service_information (the latter needs all of serviceName/serviceDefinition/
     * serviceVersion/odataInfoUri/odataVersion, sourced from the former). */
    async getServiceInfo(ref: ObjectRef, opts: { service?: string } = {}): Promise<ServiceInfo> {
      const bindingData = await fetchServices(ref);
      const services = bindingData.services ?? [];
      const svc = opts.service ? (services.find((s) => s.name === opts.service) ?? services[0]) : services[0];
      if (!svc) throw new Error(`No OData service found in binding ${ref.name}.`);
      const content = svc.content?.[0];
      if (!content) throw new Error(`Service ${svc.name} in ${ref.name} has no version content.`);
      // An unpublished binding has no service URL: V4 fails in the tool, V2 answers without one.
      // fetch_services puts `isPublished` at its top level (V4), not on the service.
      const isPublished = bindingData.isPublished ?? svc.isPublished ?? (await publishedFromDetails(ref));
      if (isPublished === false) {
        const version = bindingData.odataVersion ? ` (OData ${bindingData.odataVersion})` : '';
        throw new Error(
          `Service binding ${ref.name}${version} is not published — call publishServiceBinding first, then retry getServiceInfo.`,
        );
      }
      const res = parseFederated(
        await callTool('abap_business_services-fetch_service_information', {
          destination: dest(),
          serviceBindingName: ref.name,
          serviceName: svc.name,
          serviceDefinition: content.serviceDefinition,
          serviceVersion: content.serviceVersion,
          odataInfoUri: bindingData.odataInfoUri?.[0]?.href ?? '',
          odataVersion: bindingData.odataVersion ?? '',
          isPublished: isPublished ?? true,
        }),
      );
      if (!res.ok) throw new Error(`fetch_service_information failed for ${svc.name}: ${res.text}`);
      // A refusal ("Please publish the service binding …") comes back as a successful `{error}`.
      const data = res.data as Partial<ServiceInfo> & { error?: unknown };
      if (typeof data?.error === 'string' || typeof data?.serviceUrl !== 'string') {
        const reason = typeof data?.error === 'string' ? data.error.trim() : 'no service URL in the answer';
        throw new Error(`fetch_service_information failed for ${svc.name}: ${reason}`);
      }
      return data as ServiceInfo;
    },
  };
}
