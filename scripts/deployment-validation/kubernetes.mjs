import { finding } from './findings.mjs'

const immutableImage = /@sha256:[a-f0-9]{64}$/
const secretName = /(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL)/i

function values(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function flattenObjects(documents) {
  return documents.flatMap((document) => {
    if (document?.kind === 'List') return list(document.items)
    return document && typeof document === 'object' ? [document] : []
  })
}

function hasNamedPort(containers, targetPort) {
  return containers.some((container) =>
    list(container.ports).some((port) => port.name === targetPort || port.containerPort === targetPort),
  )
}

function probePort(probe) {
  const value = values(probe)
  return values(value.httpGet).port ?? values(value.tcpSocket).port ?? values(value.grpc).port
}

function writableVolumeSource(volume) {
  const writableSources = [
    'csi',
    'emptyDir',
    'ephemeral',
    'hostPath',
    'nfs',
    'persistentVolumeClaim',
  ]
  const source = writableSources.find((key) => Object.hasOwn(volume, key))
  if (!source) return false
  if (['csi', 'nfs', 'persistentVolumeClaim'].includes(source)) {
    return values(volume[source]).readOnly !== true
  }
  return true
}

function checkWritableTmp(findings, container, path, podSpec, podSpecPath) {
  const mounts = list(container.volumeMounts)
  const mountIndex = mounts.findIndex((mount) => mount.mountPath === '/tmp')
  if (mountIndex < 0) {
    findings.push(
      finding('DEPLOY_TMP_MOUNT_REQUIRED', `${path}.volumeMounts`, 'read-only containers need a writable /tmp mount'),
    )
    return
  }

  const mount = mounts[mountIndex]
  const mountPath = `${path}.volumeMounts[${mountIndex}]`
  if (mount.readOnly === true) {
    findings.push(
      finding(
        'DEPLOY_TMP_MOUNT_WRITABLE_REQUIRED',
        `${mountPath}.readOnly`,
        '/tmp volume mount must not be read-only',
      ),
    )
  }

  const volumes = list(podSpec.volumes)
  const volumeIndex = volumes.findIndex((volume) => volume.name === mount.name)
  if (volumeIndex < 0) {
    findings.push(
      finding(
        'DEPLOY_TMP_VOLUME_REQUIRED',
        `${mountPath}.name`,
        '/tmp volume mount must reference a declared pod volume',
      ),
    )
    return
  }

  if (!writableVolumeSource(values(volumes[volumeIndex]))) {
    findings.push(
      finding(
        'DEPLOY_TMP_VOLUME_WRITABLE_REQUIRED',
        `${podSpecPath}.volumes[${volumeIndex}]`,
        '/tmp must use writable backing storage',
      ),
    )
  }
}

function checkContainer(findings, container, path, podSpec, podSpecPath, options) {
  if (options.requireImmutableImages && !immutableImage.test(String(container.image ?? ''))) {
    findings.push(
      finding('DEPLOY_IMAGE_IMMUTABLE_REQUIRED', `${path}.image`, 'image must use an immutable @sha256 digest'),
    )
  }

  const securityContext = values(container.securityContext)
  if (securityContext.readOnlyRootFilesystem !== true) {
    findings.push(
      finding(
        'DEPLOY_CONTAINER_READ_ONLY_ROOT_REQUIRED',
        `${path}.securityContext.readOnlyRootFilesystem`,
        'container root filesystem must be read-only',
      ),
    )
  }
  if (!list(values(securityContext.capabilities).drop).includes('ALL')) {
    findings.push(
      finding(
        'DEPLOY_CAPABILITIES_DROP_ALL_REQUIRED',
        `${path}.securityContext.capabilities.drop`,
        'container must drop every Linux capability',
      ),
    )
  }
  checkWritableTmp(findings, container, path, podSpec, podSpecPath)
  if (
    options.requireSecretEnvFrom &&
    !list(container.envFrom).some((source) => values(source).secretRef)
  ) {
    findings.push(
      finding(
        'DEPLOY_SECRET_ENV_FROM_REQUIRED',
        `${path}.envFrom`,
        'container must consume secret-bearing configuration through a Secret reference',
      ),
    )
  }
  if (options.requireProbes && !container.livenessProbe) {
    findings.push(
      finding('DEPLOY_LIVENESS_PROBE_REQUIRED', `${path}.livenessProbe`, 'container must define a liveness probe'),
    )
  }
  if (options.requireProbes && !container.readinessProbe) {
    findings.push(
      finding('DEPLOY_READINESS_PROBE_REQUIRED', `${path}.readinessProbe`, 'container must define a readiness probe'),
    )
  }
  for (const probeName of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
    const port = probePort(container[probeName])
    if (port !== undefined && !hasNamedPort([container], port)) {
      const transport = values(container[probeName]).httpGet
        ? 'httpGet'
        : values(container[probeName]).tcpSocket
          ? 'tcpSocket'
          : 'grpc'
      findings.push(
        finding(
          'DEPLOY_PROBE_PORT_INVALID',
          `${path}.${probeName}.${transport}.port`,
          `${probeName} port must resolve to a port on the same container`,
        ),
      )
    }
  }
  if (options.requireResources) {
    for (const group of ['requests', 'limits']) {
      for (const resource of ['cpu', 'memory', 'ephemeral-storage']) {
        if (!values(values(container.resources)[group])[resource]) {
          findings.push(
            finding(
              'DEPLOY_RESOURCES_REQUIRED',
              `${path}.resources.${group}.${resource}`,
              `container must define ${group}.${resource}`,
            ),
          )
        }
      }
    }
  }

  const envNames = new Set()
  list(container.env).forEach((entry, index) => {
    const envPath = `${path}.env[${index}]`
    if (envNames.has(entry.name)) {
      findings.push(
        finding('DEPLOY_DUPLICATE_ENV_NAME', `${envPath}.name`, `environment variable ${entry.name} is duplicated`),
      )
    }
    envNames.add(entry.name)
    if (secretName.test(String(entry.name ?? '')) && entry.value !== undefined) {
      findings.push(
        finding(
          'DEPLOY_SECRET_ENV_REF_REQUIRED',
          `${envPath}.value`,
          `secret-bearing environment variable ${entry.name} must use valueFrom.secretKeyRef`,
        ),
      )
    } else if (
      secretName.test(String(entry.name ?? '')) &&
      !values(values(entry.valueFrom).secretKeyRef).name
    ) {
      findings.push(
        finding(
          'DEPLOY_SECRET_ENV_REF_REQUIRED',
          `${envPath}.valueFrom.secretKeyRef`,
          `secret-bearing environment variable ${entry.name} must use valueFrom.secretKeyRef`,
        ),
      )
    }
  })
}

function workloadPodTemplate(object, objectPath) {
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(object.kind)) {
    return {
      podSpec: values(values(values(object.spec).template).spec),
      podSpecPath: `${objectPath}.spec.template.spec`,
      template: values(values(object.spec).template),
      requireProbes: object.kind !== 'Job',
    }
  }
  if (object.kind === 'CronJob') {
    return {
      podSpec: values(values(values(values(values(object.spec).jobTemplate).spec).template).spec),
      podSpecPath: `${objectPath}.spec.jobTemplate.spec.template.spec`,
      template: values(values(values(values(object.spec).jobTemplate).spec).template),
      requireProbes: false,
    }
  }
  return undefined
}

function checkWorkload(findings, object, objectPath, options) {
  const workload = workloadPodTemplate(object, objectPath)
  if (!workload) return
  const { podSpec, podSpecPath } = workload
  const podSecurity = values(podSpec.securityContext)
  if (podSecurity.runAsNonRoot !== true) {
    findings.push(
      finding('DEPLOY_POD_NON_ROOT_REQUIRED', `${podSpecPath}.securityContext.runAsNonRoot`, 'pod must run as non-root'),
    )
  }
  if (values(podSecurity.seccompProfile).type !== 'RuntimeDefault') {
    findings.push(
      finding(
        'DEPLOY_SECCOMP_REQUIRED',
        `${podSpecPath}.securityContext.seccompProfile.type`,
        'pod must use the RuntimeDefault seccomp profile',
      ),
    )
  }
  list(podSpec.initContainers).forEach((container, index) =>
    checkContainer(findings, container, `${podSpecPath}.initContainers[${index}]`, podSpec, podSpecPath, {
      ...options,
      requireProbes: false,
    }),
  )
  list(podSpec.containers).forEach((container, index) =>
    checkContainer(findings, container, `${podSpecPath}.containers[${index}]`, podSpec, podSpecPath, {
      ...options,
      requireProbes: options.requireProbes && workload.requireProbes,
    }),
  )
}

function checkServices(findings, objects) {
  const workloads = objects
    .map((object, objectIndex) => workloadPodTemplate(object, `$[${objectIndex}]`))
    .filter(Boolean)
  objects.forEach((object, objectIndex) => {
    if (object.kind !== 'Service') return
    const objectPath = `$[${objectIndex}]`
    const selector = values(values(object.spec).selector)
    if (Object.keys(selector).length === 0) {
      findings.push(
        finding(
          'DEPLOY_SERVICE_SELECTOR_REQUIRED',
          `${objectPath}.spec.selector`,
          'service must declare a non-empty workload selector',
        ),
      )
    }
    const selected = workloads.filter((workload) => {
      const labels = values(values(workload.template).metadata).labels
      return Object.entries(selector).every(([key, value]) => labels?.[key] === value)
    })
    if (Object.keys(selector).length > 0 && selected.length === 0) {
      findings.push(
        finding(
          'DEPLOY_SERVICE_WORKLOAD_REQUIRED',
          `${objectPath}.spec.selector`,
          'service selector must match at least one rendered workload',
        ),
      )
    }
    const containers = selected.flatMap((workload) => list(workload.podSpec.containers))
    list(values(object.spec).ports).forEach((port, portIndex) => {
      if (
        port.targetPort === undefined ||
        !hasNamedPort(containers, port.targetPort)
      ) {
        findings.push(
          finding(
            'DEPLOY_SERVICE_TARGET_PORT_REQUIRED',
            `${objectPath}.spec.ports[${portIndex}].targetPort`,
            'service targetPort must resolve to a selected container port',
          ),
        )
      }
    })
  })
}

function checkIngress(findings, objects, options) {
  if (!options.requireIngressTls) return
  objects.forEach((object, objectIndex) => {
    if (object.kind !== 'Ingress') return
    const spec = values(object.spec)
    const tls = list(spec.tls)
    if (tls.length === 0) {
      findings.push(
        finding(
          'DEPLOY_INGRESS_TLS_REQUIRED',
          `$[${objectIndex}].spec.tls`,
          'public ingress must terminate TLS explicitly',
        ),
      )
    }
    list(spec.rules).forEach((rule, ruleIndex) => {
      if (
        rule.host &&
        !tls.some(
          (entry) =>
            values(entry).secretName &&
            list(values(entry).hosts).includes(rule.host),
        )
      ) {
        findings.push(
          finding(
            'DEPLOY_INGRESS_TLS_HOST_REQUIRED',
            `$[${objectIndex}].spec.rules[${ruleIndex}].host`,
            `ingress host ${rule.host} must be covered by a TLS secret`,
          ),
        )
      }
    })
  })
}

function checkConfigMaps(findings, objects, options) {
  const referencedNames = new Set()
  for (const [objectIndex, object] of objects.entries()) {
    const workload = workloadPodTemplate(object, `$[${objectIndex}]`)
    if (!workload) continue
    const podSpec = workload.podSpec
    for (const container of [...list(podSpec.initContainers), ...list(podSpec.containers)]) {
      for (const source of list(container.envFrom)) {
        const name = values(values(source).configMapRef).name
        if (name) referencedNames.add(name)
      }
    }
  }
  for (const key of options.requiredConfigMapKeys) {
    const objectIndex = objects.findIndex(
      (object) =>
        object.kind === 'ConfigMap' &&
        referencedNames.has(values(object.metadata).name) &&
        Object.hasOwn(values(object.data), key),
    )
    if (objectIndex < 0) {
      findings.push(
        finding(
          'DEPLOY_CONFIGMAP_KEY_REQUIRED',
          `$[?kind=ConfigMap&&referencedBy=Deployment].data.${key}`,
          `rendered configuration must wire ${key}`,
        ),
      )
    }
  }
}

function includesLabels(actual, expected) {
  const labels = values(actual)
  return Object.entries(values(expected)).every(([key, value]) => labels[key] === value)
}

function checkNetworkPolicies(findings, objects, options) {
  const requirements = options.networkPolicy
  if (!requirements) return

  const policies = objects
    .map((object, objectIndex) => ({ object, objectIndex }))
    .filter(({ object }) => object.kind === 'NetworkPolicy')
  const defaultDeny = policies.find(({ object }) =>
    String(values(object.metadata).name ?? '').endsWith('-default-deny'),
  )
  const defaultDenyPath = defaultDeny
    ? `$[${defaultDeny.objectIndex}].spec`
    : '$[?kind=NetworkPolicy&&name~=-default-deny].spec'

  if (requirements.egressMode === 'deny') {
    const spec = values(defaultDeny?.object.spec)
    if (
      !list(spec.policyTypes).includes('Egress')
      || !Array.isArray(spec.egress)
      || spec.egress.length !== 0
    ) {
      findings.push(
        finding(
          'DEPLOY_NETWORK_POLICY_DEFAULT_DENY_REQUIRED',
          `${defaultDenyPath}.egress`,
          'default-deny NetworkPolicy must select Egress and declare an empty egress list',
        ),
      )
    }
  }

  if (requirements.egressMode === 'allow') {
    const expected = values(requirements.allowedEgress)
    const matchingRule = policies.some(({ object }) =>
      list(values(object.spec).egress).some((rule) => (
        list(values(rule).to).some(
          (peer) => values(values(peer).ipBlock).cidr === expected.cidr,
        )
        && list(values(rule).ports).some((port) => values(port).port === expected.port)
      )),
    )
    if (!matchingRule) {
      findings.push(
        finding(
          'DEPLOY_NETWORK_POLICY_EGRESS_ALLOW_REQUIRED',
          '$[?kind=NetworkPolicy].spec.egress',
          `NetworkPolicy must allow ${expected.cidr} on port ${expected.port}`,
        ),
      )
    }
  }

  if (requirements.ingressPeer) {
    const expected = values(requirements.ingressPeer)
    const matchingPeer = policies.some(({ object }) =>
      list(values(object.spec).ingress).some((rule) =>
        list(values(rule).from).some((peer) => (
          includesLabels(
            values(values(peer).namespaceSelector).matchLabels,
            expected.namespaceLabels,
          )
          && includesLabels(
            values(values(peer).podSelector).matchLabels,
            expected.podLabels,
          )
        )),
      ),
    )
    if (!matchingPeer) {
      findings.push(
        finding(
          'DEPLOY_NETWORK_POLICY_INGRESS_PEER_REQUIRED',
          '$[?kind=NetworkPolicy].spec.ingress[*].from',
          'NetworkPolicy must select the approved ingress namespace and pod labels',
        ),
      )
    }
  }
}

export function validateKubernetesObjects(documents, options = {}) {
  const settings = {
    requireImmutableImages: options.requireImmutableImages ?? true,
    requireIngressTls: options.requireIngressTls ?? true,
    requireProbes: options.requireProbes ?? true,
    requireResources: options.requireResources ?? true,
    requireSecretEnvFrom: options.requireSecretEnvFrom ?? false,
    requiredConfigMapKeys: options.requiredConfigMapKeys ?? [],
    networkPolicy: options.networkPolicy,
  }
  const objects = flattenObjects(documents)
  const findings = []
  const identities = new Map()

  objects.forEach((object, objectIndex) => {
    const objectPath = `$[${objectIndex}]`
    const identity = `${object.apiVersion ?? ''}/${object.kind ?? ''}/${values(object.metadata).namespace ?? 'default'}/${values(object.metadata).name ?? ''}`
    if (identities.has(identity)) {
      findings.push(
        finding('DEPLOY_DUPLICATE_OBJECT_IDENTITY', `${objectPath}.metadata.name`, `duplicate object identity ${identity}`),
      )
    }
    identities.set(identity, objectPath)
    checkWorkload(findings, object, objectPath, settings)
  })
  checkServices(findings, objects)
  checkIngress(findings, objects, settings)
  checkConfigMaps(findings, objects, settings)
  checkNetworkPolicies(findings, objects, settings)
  return findings
}
