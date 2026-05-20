pipeline {
    agent any
    environment {
        BRANCH_NAME = "${env.BRANCH_NAME}"
    }
    tools { nodejs 'NODEJS' }
    stages {
        stage('Get SCM') {
            steps {
                sh 'rm -rf localzi-nxtmeal-tv-ads-generator'
                git branch: '$BRANCH_NAME', credentialsId:'sshkey-May2021', url:'git@github.com:localzi/localzi-nxtmeal-tv-ads-generator.git'
            }
        }
        stage('SAM Build and Deploy Stack for test') {
            when {
                expression { BRANCH_NAME != 'main' }
            }
             steps {
                  withAWS(credentials: 'SAM_CLI', region: "ap-south-1"){
                sh "${SAM_HOME}/sam build -t ./scripts/localzi-nxtmeal-tv-ads-generator.yml"
                sh "${SAM_HOME}/sam deploy --stack-name=localzi-nxtmeal-tv-ads-generator-stack-test --region=ap-south-1 --capabilities CAPABILITY_NAMED_IAM -t ./scripts/localzi-nxtmeal-tv-ads-generator.yml  --s3-bucket localzi-homeal-cf-template-test --no-fail-on-empty-changeset"
            }
             }
            post {
                success {
                    echo 'Cloud Formation Stack successfully deployed to Development using SAM template'
                }
                failure {
                    echo 'Failed deploying to Development'
                }
            }
        }
         stage('SAM Build and Deploy Stack for production') {
            when {
                expression { BRANCH_NAME == 'main' }
            }
            steps {
                 withAWS(credentials: 'SAM_CLI', region: "ap-south-1"){
                sh "${SAM_HOME}/sam build -t ./scripts/localzi-nxtmeal-tv-ads-generator.yml"
                sh "${SAM_HOME}/sam deploy --stack-name=localzi-nxtmeal-tv-ads-generator-stack-prod --region=ap-south-1 --capabilities CAPABILITY_NAMED_IAM -t ./scripts/localzi-nxtmeal-tv-ads-generator.yml --parameter-overrides  ParameterKey=Environment,ParameterValue=prod --s3-bucket localzi-homeal-cf-template-test --no-fail-on-empty-changeset"
            }
            }
            post {
                success {
                    echo 'Cloud Formation Stack successfully deployed to Production using SAM template'
                }
                failure {
                    echo 'Failed deploying to Production'
                }
            }
        }
        stage('Build') {
            steps {
                sh 'npm install'
            }
        }
        stage('Production') {
            when {
                expression {
                    BRANCH_NAME == 'main'
                }
            }
            steps {
                 withAWS(credentials: 'SAM_CLI', region: "ap-south-1"){
                sh 'zip -r ../localzi-nxtmeal-tv-ads-generator.zip node_modules *.js package.json'
                sh 'aws s3 cp ../localzi-nxtmeal-tv-ads-generator.zip s3://localzi-homeal-lambda-functions-prod'
                sh '''aws lambda update-function-code --function-name localzi-nxtmeal-tv-ads-generator-lambda-prod \\
           --s3-bucket localzi-homeal-lambda-functions-prod \\
           --s3-key localzi-nxtmeal-tv-ads-generator.zip \\
           --region ap-south-1'''
            }
            }
            post {
                success {
                    echo 'Successfully deployed to Production'
                }
                failure {
                    echo 'Failed deploying to Production'
                }
            }
        }
        stage('Development') {
            when {
                expression {
                    BRANCH_NAME == 'dev'
                }
            }
            steps {
                 withAWS(credentials: 'SAM_CLI', region: "ap-south-1"){
                sh 'zip -r ../localzi-nxtmeal-tv-ads-generator.zip node_modules *.js package.json'
                sh 'aws s3 cp ../localzi-nxtmeal-tv-ads-generator.zip s3://localzi-homeal-lambda-functions-test'
                sh '''aws lambda update-function-code --function-name localzi-nxtmeal-tv-ads-generator-lambda-test \\
           --s3-bucket localzi-homeal-lambda-functions-test \\
           --s3-key localzi-nxtmeal-tv-ads-generator.zip \\
           --region ap-south-1'''
            }
            }
            post {
                success {
                    echo 'Successfully deployed to Development'
                }
                failure {
                    echo 'Failed deploying to Development'
                }
            }
        }
        stage('Testing') {
            when {
                expression { BRANCH_NAME != 'main' && BRANCH_NAME != 'dev' }
            }
            steps {
                 withAWS(credentials: 'SAM_CLI', region: "ap-south-1"){
                sh 'zip -r ../localzi-nxtmeal-tv-ads-generator.zip node_modules *.js package.json'
                sh 'aws s3 cp ../localzi-nxtmeal-tv-ads-generator.zip s3://localzi-homeal-lambda-functions-test'
                sh '''aws lambda update-function-code --function-name localzi-nxtmeal-tv-ads-generator-lambda-test \\
           --s3-bucket localzi-homeal-lambda-functions-test \\
           --s3-key localzi-nxtmeal-tv-ads-generator.zip \\
           --region ap-south-1'''
            }
            }
            post {
                success {
                    echo 'Successfully deployed to Testing'
                }
                failure {
                    echo 'Failed deploying to Testing'
                }
            }
        }
    }
}
