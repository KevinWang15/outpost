FROM alpine:3.22
RUN apk add --no-cache openrc curl ca-certificates libstdc++ libgcc bash
CMD ["sh", "-c", "mkdir -p /run/openrc; touch /run/openrc/softlevel; openrc default; exec sleep infinity"]
