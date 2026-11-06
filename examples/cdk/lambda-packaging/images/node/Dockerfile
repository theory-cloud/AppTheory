FROM public.ecr.aws/lambda/nodejs:24
ARG IMAGE_VALUE=node-image-build
COPY app.js ${LAMBDA_TASK_ROOT}/
RUN printf '%s' "$IMAGE_VALUE" > ${LAMBDA_TASK_ROOT}/image-value.txt
CMD ["app.handler"]
