FROM public.ecr.aws/lambda/python:3.14
ARG IMAGE_VALUE=python-image-build
COPY app.py ${LAMBDA_TASK_ROOT}/
RUN printf '%s' "$IMAGE_VALUE" > ${LAMBDA_TASK_ROOT}/image-value.txt
CMD ["app.handler"]
