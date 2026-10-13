FROM debian:bookworm-slim

# Prevent interactive debconf prompts and set container environment
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PUID=1000 \
    PGID=1000 \
    UMASK=002 \
    HOME=/home/steam \
    DOWNLOAD_DIR=/downloads \
    DATA_DIR=/app/data \
    STEAMCMD_PATH=/steamcmd/steamcmd.sh \
    PATH="/opt/venv/bin:$PATH"

# Install system dependencies, 32-bit architecture for SteamCMD, and Python
RUN dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       tar \
       gosu \
       python3 \
       python3-pip \
       python3-venv \
       lib32gcc-s1 \
       lib32stdc++6 \
       libc6:i386 \
       libstdc++6:i386 \
       libcurl4:i386 \
       libbz2-1.0:i386 \
       unzip \
       locales \
    && echo "en_US.UTF-8 UTF-8" > /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# Install SteamCMD from Valve official distribution
RUN mkdir -p /steamcmd \
    && curl -fsSL "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz" | tar -zxvf - -C /steamcmd \
    && chmod -R 777 /steamcmd \
    && chmod -R +x /steamcmd \
    && mkdir -p /usr/games \
    && ln -sf /steamcmd/steamcmd.sh /usr/games/steamcmd \
    && mkdir -p /home/steam \
    && chmod -R 777 /home/steam

# Pre-populate SteamCMD runtime caches
RUN /steamcmd/steamcmd.sh +quit || true \
    && chmod -R 777 /steamcmd \
    && chmod -R +x /steamcmd

# Set up Python isolated virtual environment
RUN python3 -m venv /opt/venv

# Install Python requirements
WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

# Version tracking build args
ARG APP_COMMIT_SHA=revival
ARG APP_VERSION=2.0.0
ENV APP_COMMIT_SHA=${APP_COMMIT_SHA}
ENV APP_VERSION=${APP_VERSION}

# Copy entrypoint script and application code (including pre-bundled Goldberg binaries)
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
COPY app /app/app

# Define persistent storage volumes
VOLUME ["/downloads", "/app/data"]

EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
