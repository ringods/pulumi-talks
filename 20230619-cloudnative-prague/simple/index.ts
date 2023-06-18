import * as aws from "@pulumi/aws";
import { CannedAcl } from "@pulumi/aws/s3";

// Create an AWS resource (S3 Bucket)
const bucket = new aws.s3.Bucket("my-bucket",
{
    acl: CannedAcl.PublicRead
});

// Export the name of the bucket
export const bucketName = bucket.id;
