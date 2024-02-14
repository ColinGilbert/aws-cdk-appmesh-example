import * as appmesh from "aws-cdk-lib/aws-appmesh";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cloudmap from "aws-cdk-lib/aws-servicediscovery";
import * as cdk from "aws-cdk-lib";
import * as path from "path";
import { Construct } from "constructs";

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // fargate cluster
    const vpc = ec2.Vpc.fromLookup(this, "default-vpc", { isDefault: true });
    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc: vpc,
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, "public-alb", {
      vpc,
      internetFacing: true,
    });

    new cdk.CfnOutput(this, "alb-dns-name", {
      value: `http://${alb.loadBalancerDnsName}`,
    });

    const listener = alb.addListener("http-listener", {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
    });

    const namespace = new cloudmap.PrivateDnsNamespace(this, "test-namespace", {
      vpc,
      name: "service.local",
    });

    const mesh = new appmesh.Mesh(this, "mesh", {
      meshName: "sample-mesh",
    });

    const {
      service: backendFGService,
      port: backendPort,
      node: backendNode,
    } = this.createService(
      "backend-1",
      cluster,
      ecs.ContainerImage.fromAsset(
        path.resolve(__dirname, "..", "..", "services", "color-teller-backend")
      ),
      namespace,
      mesh,
      {
        COLOR: "red",
      }
    );
    const backendVService = this.createVirtualService(
      "color-service",
      mesh,
      backendNode,
      namespace
    );

    const {
      service: clientFGService,
      port: appPort,
      node: clientNode,
    } = this.createService(
      "client-1",
      cluster,
      ecs.ContainerImage.fromAsset(
        path.resolve(__dirname, "..", "..", "services", "color-teller-client")
      ),
      namespace,
      mesh,
      {
        COLOR_BACKEND: `http://${backendVService.virtualServiceName}:${backendPort}`,
        VERSION: "vanilla",
      }
    );
    const clientVService = this.createVirtualService(
      "client-service",
      mesh,
      clientNode,
      namespace
    );

    clientNode.addBackend(appmesh.Backend.virtualService(backendVService));
    backendFGService.connections.allowFrom(
      clientFGService,
      ec2.Port.tcp(backendPort)
    );

    const { gateway: virtualGateway, fgService: virtualGatewayFGService } =
      this.createIngressService(cluster, listener, mesh);

    const clientVRouter = new appmesh.VirtualRouter(
      this,
      "client-virtual-router",
      {
        mesh,
        listeners: [appmesh.VirtualRouterListener.http(3000)],
      }
    );

    clientVRouter.addRoute("default", {
      routeSpec: appmesh.RouteSpec.http({
        weightedTargets: [
          {
            weight: 1,
            virtualNode: clientNode,
          },
        ],
      }),
    });

    virtualGateway.addGatewayRoute("web-route", {
      routeSpec: appmesh.GatewayRouteSpec.http({
        routeTarget: clientVService,
        match: {
          path: appmesh.HttpGatewayRoutePathMatch.startsWith("/"),
        },
      }),
    });
    clientFGService.connections.allowFrom(
      virtualGatewayFGService,
      ec2.Port.tcp(appPort)
    );
  }
  private createService(
    id: string,
    cluster: ecs.Cluster,
    image: ecs.ContainerImage,
    namespace: cloudmap.PrivateDnsNamespace,
    mesh: appmesh.Mesh,
    envOverwrite: { [key: string]: string } = {}
  ): {
    service: ecs.FargateService;
    port: number;
    privateDnsName: string;
    node: appmesh.VirtualNode;
  } {
    const appPort = 3000;
    const taskDef = new ecs.FargateTaskDefinition(
      this,
      `${id}-fargate-task-def`,
      {
        memoryLimitMiB: 1024,
        proxyConfiguration: new ecs.AppMeshProxyConfiguration({
          containerName: "envoy",
          properties: {
            ignoredUID: 1337,
            appPorts: [appPort],
            proxyIngressPort: 15000,
            proxyEgressPort: 15001,
            egressIgnoredIPs: ["169.254.170.2", "169.254.169.254"],
          },
        }),
      }
    );
    const appContainer = taskDef.addContainer("app", {
      image,
      logging: new ecs.AwsLogDriver({ streamPrefix: `${id}-app-` }),
      portMappings: [{ containerPort: appPort, hostPort: appPort }],
      environment: {
        PORT: `${appPort}`,
        ...envOverwrite,
      },
    });
    const virtualNodeName = `${id}-virtual-node`;
    const envoyContainer = taskDef.addContainer("envoy", {
      image: ecs.ContainerImage.fromRegistry(
        "public.ecr.aws/appmesh/aws-appmesh-envoy:v1.19.1.0-prod"
      ),
      essential: true,
      environment: {
        // https://docs.aws.amazon.com/app-mesh/latest/userguide/envoy-config.html
        APPMESH_RESOURCE_ARN: `arn:aws:appmesh:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:mesh/${mesh.meshName}/virtualNode/${virtualNodeName}`,
        ENABLE_ENVOY_STATS_TAGS: "1",
        ENABLE_ENVOY_XRAY_TRACING: "1",
        ENVOY_LOG_LEVEL: "debug",
      },
      healthCheck: {
        command: [
          "CMD-SHELL",
          "curl -s http://localhost:9901/server_info | grep state | grep -q LIVE",
        ],
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        startPeriod: cdk.Duration.seconds(10),
        retries: 3,
      },
      user: "1337",
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${id}-envoy-`,
      }),
    });

    envoyContainer.addUlimits({
      name: ecs.UlimitName.NOFILE,
      hardLimit: 15000,
      softLimit: 15000,
    });
    appContainer.addContainerDependencies({
      container: envoyContainer,
    });

    taskDef.addContainer(`${id}-xray`, {
      image: ecs.ContainerImage.fromRegistry(
        "public.ecr.aws/xray/aws-xray-daemon:latest"
      ),
      memoryReservationMiB: 256,
      environment: {
        AWS_REGION: cdk.Aws.REGION,
      },
      user: "1337", // X-Ray traffic should not go through Envoy proxy
      logging: new ecs.AwsLogDriver({
        streamPrefix: id + "-xray-",
      }),
      portMappings: [
        {
          containerPort: 2000,
          protocol: ecs.Protocol.UDP,
        },
      ],
    });
    const service = new ecs.FargateService(this, `${id}-service`, {
      cluster,
      assignPublicIp: true, // for public vpc
      minHealthyPercent: 0, // for zero downtime rolling deployment set desiredcount=2 and minHealty = 50
      desiredCount: 1,
      taskDefinition: taskDef,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [
        new ec2.SecurityGroup(this, `${id}-default-sg`, {
          securityGroupName: `${id}-fargate-service`,
          vpc: cluster.vpc,
        }),
      ],
      cloudMapOptions: {
        name: id,
        cloudMapNamespace: namespace,
        containerPort: appPort,
        dnsRecordType: cloudmap.DnsRecordType.SRV,
      },
    });

    const bgNode = new appmesh.VirtualNode(this, `${id}-virtual-node`, {
      mesh,
      virtualNodeName: virtualNodeName,
      accessLog: appmesh.AccessLog.fromFilePath("/dev/stdout"),
      serviceDiscovery: appmesh.ServiceDiscovery.cloudMap(
        service.cloudMapService!
      ),
      listeners: [
        appmesh.VirtualNodeListener.http({
          port: appPort,
          connectionPool: {
            maxConnections: 1024,
            maxPendingRequests: 1024,
          },
          healthCheck: appmesh.HealthCheck.http({
            path: "health",
          }),
        }),
      ],
    });

    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess")
    );
    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSAppMeshEnvoyAccess")
    );
    return {
      service,
      port: appPort,
      privateDnsName: `${id}.${namespace.namespaceName}`,
      node: bgNode,
    };
  }

  private createVirtualService(
    serviceName: string,
    mesh: appmesh.Mesh,
    backendNode: appmesh.VirtualNode,
    namespace: cloudmap.PrivateDnsNamespace
  ): appmesh.VirtualService {
    const router = new appmesh.VirtualRouter(
      this,
      `${serviceName}-virtual-router`,
      {
        mesh,
        listeners: [appmesh.VirtualRouterListener.http(3000)],
      }
    );

    router.addRoute("default", {
      routeSpec: appmesh.RouteSpec.http({
        weightedTargets: [
          {
            weight: 1,
            virtualNode: backendNode,
          },
        ],
      }),
    });

    const service = new appmesh.VirtualService(this, serviceName, {
      virtualServiceProvider:
        appmesh.VirtualServiceProvider.virtualRouter(router),
      virtualServiceName: `${serviceName}.${namespace.namespaceName}`,
    });
    // https://docs.aws.amazon.com/app-mesh/latest/userguide/troubleshoot-connectivity.html#ts-connectivity-dns-resolution-virtual-service
    new cloudmap.Service(this, `${serviceName}-dummy-service`, {
      namespace,
      name: serviceName,
      dnsRecordType: cloudmap.DnsRecordType.A,
      description: "The dummy for App Mesh",
    }).registerIpInstance("dummy-instance", { ipv4: "10.10.10.10" });

    return service;
  }

  private createIngressService(
    cluster: ecs.Cluster,
    listener: elbv2.ApplicationListener,
    mesh: appmesh.Mesh
  ): {
    gateway: appmesh.VirtualGateway;
    fgService: ecs.FargateService;
  } {
    const port = 8080;
    const gateway = new appmesh.VirtualGateway(this, "virtual-gateway", {
      mesh,
      listeners: [appmesh.VirtualGatewayListener.http({ port })],
    });

    const taskDef = new ecs.FargateTaskDefinition(
      this,
      "ingress-fargate-task-def",
      {
        memoryLimitMiB: 512,
      }
    );

    const container = taskDef.addContainer("app", {
      // most up-to-date envoy image at the point of writing the article
      image: ecs.ContainerImage.fromRegistry(
        "public.ecr.aws/appmesh/aws-appmesh-envoy:v1.19.1.0-prod"
      ),
      logging: new ecs.AwsLogDriver({ streamPrefix: "ingress-app-" }),
      portMappings: [
        { containerPort: port },
        { containerPort: 9901 }, // for health check
      ],
      healthCheck: {
        // health check from Documentation
        command: [
          "CMD-SHELL",
          "curl -s http://localhost:9901/server_info | grep state | grep -q LIVE || exit 1",
        ],
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        startPeriod: cdk.Duration.seconds(10),
        retries: 3,
      },
      environment: {
        APPMESH_RESOURCE_ARN: `arn:aws:appmesh:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:mesh/${mesh.meshName}/virtualGateway/${gateway.virtualGatewayName}`,
        AWS_REGION: cdk.Aws.REGION,
        // ENABLE_ENVOY_STATS_TAGS: '1',
        // ENABLE_ENVOY_XRAY_TRACING: '1',
      },
      user: "1337",
      memoryLimitMiB: 320, // limit examples from the official docs
      cpu: 208, // limit examples from the official docs
    });
    // limit examples from the official docs
    container.addUlimits({
      name: ecs.UlimitName.NOFILE,
      hardLimit: 1024000,
      softLimit: 1024000,
    });

    taskDef.addContainer(`ingress-xray`, {
      image: ecs.ContainerImage.fromRegistry(
        "public.ecr.aws/xray/aws-xray-daemon:latest"
      ),
      memoryReservationMiB: 256,
      user: "1337",
      environment: {
        AWS_REGION: cdk.Aws.REGION,
      },
      logging: new ecs.AwsLogDriver({
        streamPrefix: "ingress-xray-",
      }),
      portMappings: [
        {
          containerPort: 2000,
          protocol: ecs.Protocol.UDP,
        },
      ],
    });

    const service = new ecs.FargateService(this, "ingress-service", {
      cluster,
      assignPublicIp: true, // for public vpc
      minHealthyPercent: 0, // for zero downtime rolling deployment set desiredcount=2 and minHealty = 50
      desiredCount: 1,
      taskDefinition: taskDef,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [
        new ec2.SecurityGroup(this, "ingress-default-sg", {
          securityGroupName: "ingress-fargate-service",
          vpc: cluster.vpc,
        }),
      ],
    });
    listener.addTargets("ingress-gateway-target", {
      port,
      protocol: elbv2.ApplicationProtocol.HTTP,
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        interval: cdk.Duration.seconds(10),
        // health port from aws-envoy docs
        port: "9901",
        // health check path from aws-envoy docs
        path: "/server_info",
      },
      targets: [service],
      deregistrationDelay: cdk.Duration.seconds(0), // not needed, just speeds up the deployment for this example
    });

    // required so the ALB can reach the health-check endpoint
    service.connections.allowFrom(listener, ec2.Port.tcp(9901));
    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSAppMeshEnvoyAccess")
    );
    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess")
    );
    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchAgentServerPolicy")
    );

    return { gateway, fgService: service };
  }
}
