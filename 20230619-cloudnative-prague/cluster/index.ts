import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as fs from 'fs';
import { AssertionError } from "assert";

const projectName = pulumi.getProject();
const stack = pulumi.getStack()

const awsConfig = new pulumi.Config("aws")
const awsRegion = awsConfig.require("region")
const demoName = "cn-prague";

// ##### Network
const vpc = new awsx.ec2.Vpc(demoName, {
    cidrBlock: "10.0.0.0/16",
    tags: {
        "Name": `${projectName}`
    },
});


// ##### Kubernetes Cluster
const cluster = new eks.Cluster(demoName, {
    vpcId: vpc.vpcId,
    publicSubnetIds: vpc.publicSubnetIds,
    nodeGroupOptions: {
        desiredCapacity: 2,
        minSize: 1,
        maxSize: 3,
        instanceType: "t2.small",
    },
    createOidcProvider: true,
})

const ns = "aws-lb-controller"
const service_account_name = `system:serviceaccount:${ns}:aws-lb-controller-serviceaccount`

function assertIsDefined<T>(val: T): asserts val is NonNullable<T> {
    if (val === undefined || val === null) {
        throw new AssertionError(
            { message: `Expected 'val' to be defined, but received ${val}` }
        );
    }
}

const oidcArn = cluster.core.oidcProvider?.arn
assertIsDefined(oidcArn)
const oidcUrl = cluster.core.oidcProvider?.url
assertIsDefined(oidcUrl)

const iamRole = new aws.iam.Role("aws-loadbalancer-controller-role",
    {
        assumeRolePolicy: pulumi.all([oidcArn, oidcUrl]).apply(
            ([arn, url]) => {
                let conditionStringEquals: { [key: string]: string | number; } = {};
                conditionStringEquals[`${url}:sub`] = service_account_name;

                return JSON.stringify(
                    {
                        Version: "2012-10-17",
                        Statement: [
                            {
                                Effect: "Allow",
                                Principal: {
                                    Federated: arn,
                                },
                                Action: "sts:AssumeRoleWithWebIdentity",
                                Condition: {
                                    StringEquals: conditionStringEquals
                                }
                            }
                        ],
                    }
                );
            }
        ),
    }
)

const iamPolicyContent = fs.readFileSync('iam_policy.json', 'utf-8');
const iamPolicy = new aws.iam.Policy("aws-loadbalancer-controller-policy",
    {
        policy: iamPolicyContent,
    },
    {
        parent: iamRole,
    }
)

const policyAttachment = new aws.iam.PolicyAttachment("aws-loadbalancer-controller-attachment",
    {
        policyArn: iamPolicy.arn,
        roles: [iamRole.name],
    },
    {
        parent: iamRole
    }
)

// #### AWS Load Balancer Controller
const provider = new k8s.Provider("provider", {
    kubeconfig: cluster.kubeconfig
})

const namespace = new k8s.core.v1.Namespace(`${ns}-ns`,
    {
        metadata: {
            name: ns,
            labels: {
                "app.kubernetes.io/name": "aws-load-balancer-controller",
            }
        },
    },
    {
        provider: provider,
        parent: provider,
    }
)

const serviceAccount = new k8s.core.v1.ServiceAccount("aws-lb-controller-sa",
    {
        metadata: {
            name: "aws-lb-controller-serviceaccount",
            namespace: namespace.metadata.name,
            annotations: {
                "eks.amazonaws.com/role-arn": iamRole.arn
            }
        }
    },
    {
        provider: provider,
    }
)

const removeStatusField: pulumi.ResourceTransformation = (args) => {
    if (args.type === "kubernetes:apiextensions.k8s.io/v1:CustomResourceDefinition") {
        args.props.spec.versions.forEach((version: any) => {
            if (version.hasOwnProperty("subresources") && version.subresources.hasOwnProperty("status")) {
                delete version.subresources.status;
            }
        });
    }
    return { props: args.props, opts: args.opts };
};

const awsLbController = new k8s.helm.v3.Chart("lb",
    {
        chart: "aws-load-balancer-controller",
        fetchOpts: {
            repo: "https://aws.github.io/eks-charts"
        },
        namespace: namespace.metadata.name,
        values: {
            region: awsRegion,
            serviceAccount: {
                name: serviceAccount.metadata.name,
                create: false,
            },
            vpcId: vpc.vpcId,
            clusterName: cluster.eksCluster.name,
            podLabels: {
                stack: stack,
                app: "aws-lb-controller"
            }
        }
    },
    {
        transformations: [removeStatusField],
        provider: provider,
        parent: namespace
    }
)

// Export the cluster kubeconfig.
export const kubeconfig = pulumi.secret(cluster.kubeconfig);
